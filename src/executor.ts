import { type JsonValue, Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension
} from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
  StreamableHTTPError
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ExecutorView } from "./protocol";
import type { Vault } from "./vault";

/**
 * Executor (v2.executor.sh) over MCP. Executor holds the accounts and turns
 * apps into tools behind three MCP tools: `skills` reads what an app ships,
 * `execute` runs a JavaScript program over the apps (`tools.<app>.<tool>()`),
 * and `resume` continues a program that paused for an approval.
 *
 * The connection uses a personal access token on the organization's URL in
 * browser elicitation mode, so an approval arrives as a link the user opens,
 * and the agent calls `resume` after.
 */

/** Where Executor is and the token it takes, as the user connects it in Settings; kept in the Vault. */
export type ExecutorConnection = { readonly url: string; readonly token: string };

/** ky installs Executor's tools only while one is connected. */
export type ExecutorConfig = ExecutorConnection & {
  /** How requests reach Executor; global fetch unless set. */
  readonly fetch?: typeof fetch;
};

/** What Settings shows of Executor: its address once connected, never the token. */

type CallResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const REQUEST_TIMEOUT_MS = 6 * 60_000;

const failed = (error: Error): CallResult => ({
  content: [{ type: "text", text: `Executor call failed: ${error.message}` }],
  isError: true
});

/** One try at a call, and whether it provably never reached Executor, so it may be tried again. */
type Attempt = { result: CallResult; neverRan: boolean };

/** Whether Executor answered with one of these HTTP statuses. */
function answered(error: Error, ...codes: number[]): boolean {
  return error instanceof StreamableHTTPError && error.code !== undefined && codes.includes(error.code);
}

/** An MCP tool result as pi tool content: text parts as they are, anything else as JSON. */
function toResult(result: Awaited<ReturnType<Client["callTool"]>>): CallResult {
  const content = (Array.isArray(result.content) ? result.content : []).map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "text" as const, text: JSON.stringify(part) }
  );

  if (result.structuredContent !== undefined && content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  }

  return { content, isError: result.isError === true };
}

/** An MCP session with Executor, signed in with the token. */
async function open(config: ExecutorConfig): Promise<Client> {
  const client = new Client({ name: "ky", version: "0.1.0" });

  const options: StreamableHTTPClientTransportOptions = {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } }
  };

  if (config.fetch) options.fetch = config.fetch;
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), options));

  return client;
}

class ExecutorClient {
  readonly #config: ExecutorConfig;
  #client: Promise<Client> | undefined;

  constructor(config: ExecutorConfig) {
    this.#config = config;
  }

  #connect(): Promise<Client> {
    if (this.#client) return this.#client;

    const connecting = open(this.#config);

    // A failed connect is not kept; the caller still sees its error.
    connecting.catch(() => this.#forget(connecting));
    this.#client = connecting;

    return connecting;
  }

  /** Drop a connection, unless a newer one already replaced it. */
  #forget(connection: Promise<Client>): void {
    if (this.#client !== connection) return;
    this.#client = undefined;
    connection.then((client) => client.close()).catch(() => undefined);
  }

  /**
   * `execute` and `resume` can act in the user's accounts, so a call is
   * retried only when it provably never reached Executor: the connection could
   * not be made, or Executor refused the session before running anything. A
   * timeout or a lost response can come after the program ran, so it is
   * reported, never retried.
   */
  async call(
    name: string,
    args: Record<string, JsonValue | undefined>,
    signal: AbortSignal | undefined
  ): Promise<CallResult> {
    for (let attempt = 0; ; attempt++) {
      const retry = attempt === 0 && signal?.aborted !== true;
      const { result, neverRan } = await this.#attempt(name, args, signal);

      if (!retry || !neverRan) return result;
    }
  }

  async #attempt(
    name: string,
    args: Record<string, JsonValue | undefined>,
    signal: AbortSignal | undefined
  ): Promise<Attempt> {
    const connection = this.#connect();
    let client: Client;

    try {
      client = await connection;
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));

      // A refused token stays refused; only a connection that may not have been made is tried again.
      return { result: failed(error), neverRan: !answered(error, 401, 403) };
    }

    try {
      const options: RequestOptions = { timeout: REQUEST_TIMEOUT_MS };

      if (signal) options.signal = signal;

      return { result: toResult(await client.callTool({ name, arguments: args }, undefined, options)), neverRan: false };
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));

      // An aborted call leaves the connection working; any other failure may not.
      if (signal?.aborted !== true) this.#forget(connection);

      // Executor refused the session as unknown or expired: the Streamable HTTP spec answers 404 before running anything.
      return { result: failed(error), neverRan: answered(error, 404) };
    }
  }
}

const GUIDE = `Executor connects the user's accounts and apps (calendar, email, GitHub, Vercel and whatever else they added). Use it for anything that touches their services.

- executor_skills: read what apps are available and the instructions they ship. Start here when you do not know what is connected.
- executor_execute: run a short JavaScript program. Inside it, \`await tools.search({ query: "..." })\` returns callable paths and TypeScript signatures, and app tools are async functions like \`await tools.vercel.listProjects({})\`. Join and filter results in the program and return only what you need. There is no fetch, no filesystem and no imports. Limits: 100 tool calls, 5 minutes, 64 KB of output.
- If a result carries an approvalUrl, give the user that link, wait for them to say they decided, then call executor_resume with the requestId. Never re-run a program to get past a refusal: earlier calls may already have taken effect.`;

export function executorExtension(config: ExecutorConfig): Extension {
  const executor = new ExecutorClient(config);

  return defineExtension({
    name: "executor",
    sections: [{ key: "executor", render: () => GUIDE }],
    tools: [
      defineTool({
        name: "executor_skills",
        description:
          "List the user's Executor apps and their skills, or read one. No app: everything visible. app: one app's skills. app and name: one skill.",
        parameters: Type.Object({
          app: Type.Optional(Type.String()),
          name: Type.Optional(Type.String())
        }),
        replay: "safe",
        execute: async (args, _api, context) => executor.call("skills", args, context.abortSignal)
      }),
      defineTool({
        name: "executor_execute",
        description:
          "Run a JavaScript program over the user's Executor apps. `tools.search({ query })` finds tools; app tools are `await tools.<app>.<tool>(input)`. Return the result.",
        parameters: Type.Object({
          code: Type.String({ description: "The program body. It may use await and must return its result." })
        }),
        // A program can have side effects in the user's accounts.
        replay: "unsafe",
        execute: async (args, _api, context) => executor.call("execute", args, context.abortSignal)
      }),
      defineTool({
        name: "executor_resume",
        description:
          "Continue an Executor program that paused for an approval or for input, after the user decided.",
        parameters: Type.Object(
          { requestId: Type.String() },
          { additionalProperties: true }
        ),
        replay: "unsafe",
        execute: async (args, _api, context) => executor.call("resume", args, context.abortSignal)
      })
    ]
  });
}

/** Executor's address: https, or http on localhost for a local Executor. */
function checkUrl(url: string): string | undefined {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a URL. Paste Executor's MCP address, like https://v2.executor.sh/org/<org>/mcp.";
  }

  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    return undefined;
  }

  return "Executor's address must start with https://.";
}

/** Why a test connection failed, in words that hold no secret. */
function whyRefused(error: Error, url: string): string {
  if (answered(error, 401, 403)) return "Executor refused that token.";

  return `ky couldn't reach Executor at ${new URL(url).origin}: ${error.message}`;
}

/**
 * Settings › Executor: the user connects Executor with its URL and a
 * personal access token. ky signs in and lists its tools first, and keeps
 * the connection in the Vault only once that works; the token never comes
 * back to the browser. While connected, the agent has Executor's tools.
 */
export class ExecutorLink {
  readonly #vault: () => DurableObjectStub<Vault>;
  /** The Vault's id for it, `("executor", id)`: the agent's name, so each agent has its own. */
  readonly #id: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #listeners = new Set<() => Promise<void> | void>();

  constructor(vault: () => DurableObjectStub<Vault>, id: string, reach?: typeof fetch) {
    this.#vault = vault;
    this.#id = id;
    this.#fetch = reach;
  }

  /** Called on connect and disconnect, which resolve once every listener has. */
  onChange(listener: () => Promise<void> | void): void {
    this.#listeners.add(listener);
  }

  /** The connection the agent's tools use, or null while none is. */
  async config(): Promise<ExecutorConfig | null> {
    const connection = await this.#vault().executor(this.#id);

    if (!connection) return null;

    return this.#fetch ? { ...connection, fetch: this.#fetch } : connection;
  }

  async view(): Promise<ExecutorView> {
    const secret = (await this.#vault().status()).find((each) => each.kind === "executor" && each.id === this.#id);
    const url = secret?.meta?.url;

    return { url: url ? String(url) : null };
  }

  /** Sign in to Executor at `url` with `token` and list its tools; keep it only if that works, else `{ refused }`. */
  async connect(url: string, token: string): Promise<{ refused?: string }> {
    const connection = { url: url.trim(), token: token.trim() };

    if (connection.token === "") return { refused: "Paste an Executor personal access token." };
    const bad = checkUrl(connection.url);

    if (bad) return { refused: bad };

    try {
      const client = await open(this.#fetch ? { ...connection, fetch: this.#fetch } : connection);

      try {
        await client.listTools(undefined, { timeout: 30_000 });
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (error) {
      return { refused: whyRefused(error instanceof Error ? error : new Error(String(error)), connection.url) };
    }

    await this.#vault().put("executor", this.#id, connection, { url: connection.url });
    await this.#changed();

    return {};
  }

  /** Forget the connection: the agent loses Executor's tools. */
  async disconnect(): Promise<void> {
    await this.#vault().remove("executor", this.#id);
    await this.#changed();
  }

  async #changed(): Promise<void> {
    await Promise.all([...this.#listeners].map((listener) => listener()));
  }
}
