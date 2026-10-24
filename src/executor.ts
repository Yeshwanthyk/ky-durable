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
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { toolReply } from "./core/reply";
import type { ExecutorView } from "./protocol";
import type { Vault } from "./vault";

/**
 * Executor (v2.executor.sh) over MCP. Executor holds the accounts and turns
 * apps into tools behind three MCP tools: `skills` reads what an app ships,
 * `execute` runs a JavaScript program over the apps (`tools.<app>.<tool>()`),
 * and `resume` continues a program that paused for an approval or for input.
 *
 * The connection uses a personal access token, so ky never needs a browser
 * sign-in, and always runs in model elicitation mode: a tool that needs
 * approval pauses with `status: "approval-required"`. The approval is the
 * user's, never the model's: every reply passes through the gate
 * (src/approvals/executor.ts), which shows the user a card, and their tap
 * resumes the program from the server. The model's executor_resume can only
 * decline, cancel, or answer a request for input. Browser mode can't work for ky,
 * because there a request belongs to the MCP session that made it, and ky's
 * session lives in the Durable Object's memory: it is gone after the object
 * hibernates while the user approves, and `resume` then finds nothing. In model
 * mode a new session on the same token can still answer the request.
 */

/** Where Executor is and the token it takes, as the user connects it in Settings; kept in the Vault. */
export type ExecutorConnection = { readonly url: string; readonly token: string };

/** ky installs Executor's tools only while one is connected. */
export type ExecutorConfig = ExecutorConnection & {
  /** How requests reach Executor; global fetch unless set. */
  readonly fetch?: typeof fetch;
};

/** An Executor tool's answer, as pi tool output. */
export type CallResult = { output: Array<{ type: "text"; text: string }>; isError?: boolean };

/** A call to one of Executor's MCP tools on a session already open. */
export type ExecutorCall = (name: string, args: Record<string, JsonValue | undefined>) => Promise<CallResult>;

/** What the model may answer a paused request with: never accept, which is the user's tap. */
export type ResumeAction = "answer" | "decline" | "cancel";

/** Where ky takes Executor's pauses from the model: src/approvals/executor.ts. */
export interface ExecutorGate {
  /** Executor's reply to execute or resume in `conversation`, after ky took any pause it holds. */
  replied(result: CallResult, conversation: string, call: ExecutorCall): Promise<CallResult>;
  /** Why the model may not resume `requestId` so, or undefined when it may; a decline or cancel of an approval is claimed here. */
  beforeResume(requestId: string, action: ResumeAction, conversation: string): string | undefined;
  /** A resume the model sent reached Executor. */
  resumed(requestId: string): void;
}

const REQUEST_TIMEOUT_MS = 6 * 60_000;

const failed = (error: Error): CallResult => ({
  output: [{ type: "text", text: `Executor call failed: ${error.message}` }],
  isError: true
});

/** One try at a call, and whether it provably never reached Executor, so it may be tried again. */
type Attempt = { result: CallResult; neverRan: boolean };

/** Whether Executor answered with one of these HTTP statuses. */
function answered(error: Error, ...codes: number[]): boolean {
  return error instanceof StreamableHTTPError && error.code !== undefined && codes.includes(error.code);
}

/** An MCP tool result as pi tool output: text parts as they are, anything else as JSON. */
function toResult(result: Awaited<ReturnType<Client["callTool"]>>): CallResult {
  const content = (Array.isArray(result.content) ? result.content : []).map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "text" as const, text: JSON.stringify(part) }
  );

  if (result.structuredContent !== undefined && content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  }

  return { output: content, isError: result.isError === true };
}

/** An MCP session with Executor, signed in with the token. */
async function open(config: ExecutorConfig): Promise<Client> {
  // Workers refuse code built from strings, which the default validator (Ajv) needs for tools' output schemas.
  const client = new Client({ name: "ky", version: "0.1.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });

  const options: StreamableHTTPClientTransportOptions = {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } }
  };

  if (config.fetch) options.fetch = config.fetch;
  await client.connect(new StreamableHTTPClientTransport(modelMode(config.url), options));

  return client;
}

/**
 * The URL ky connects to: the saved one without `elicitation_mode`, so
 * Executor uses model mode, its default. The same token works in every mode,
 * and the saved URL is left as it is.
 */
function modelMode(url: string): URL {
  const parsed = new URL(url);

  parsed.searchParams.delete("elicitation_mode");

  return parsed;
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

  /** Close the session, once nothing more will be called. */
  close(): void {
    if (this.#client) this.#forget(this.#client);
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

/** One call outside a turn, as the user's tap on an approval resumes a program, on a session of its own that closes after. */
export async function callOnce(
  config: ExecutorConfig,
  name: string,
  args: Record<string, JsonValue | undefined>,
  signal?: AbortSignal
): Promise<CallResult> {
  const executor = new ExecutorClient(config);

  try {
    return await executor.call(name, args, signal);
  } finally {
    executor.close();
  }
}

/** Run one program outside a turn, as an automation's gate does. */
export async function executeOnce(
  config: ExecutorConfig,
  code: string,
  signal: AbortSignal
): Promise<{ text: string; error: boolean }> {
  const result = await callOnce(config, "execute", { code }, signal);

  return { text: result.output.map((part) => part.text).join("\n"), error: result.isError === true };
}

const GUIDE = `Executor connects the user's accounts and apps (calendar, email, GitHub, Vercel and whatever else they added). Use it for anything that touches their services.

- executor_skills: read what apps are available and the instructions they ship. Start here when you do not know what is connected.
- executor_execute: run a short JavaScript program. Inside it, \`await tools.search({ query: "..." })\` returns callable paths and TypeScript signatures, and app tools are async functions like \`await tools.vercel.listProjects({})\`. Join and filter results in the program and return only what you need. There is no fetch, no filesystem and no imports. Limits: 100 tool calls, 5 minutes, 64 KB of output.

Approvals are the user's, and you can't give one. A tool that needs approval pauses the program, and the result has \`status: "approval-required"\`, a requestId, and what the tool is about to do. ky shows the user a card for it, and only their tap on the card approves it; ky then resumes the program and tells you here what came of it.
1. Tell the user in plain words what will happen: what is sent, changed or deleted, where, and to whom. Decode what they can't read. For a Gmail send, decode the base64url \`raw\` and show the recipient, the subject and the body. Don't show the encoded text.
2. Stop. Don't ask them to say yes in the chat: a yes in words approves nothing. Point them to the card.
3. If they say no or want to stop, call executor_resume with \`action: "decline"\` or \`action: "cancel"\`.

A result with \`status: "input-required"\` asks for information: ask the user, then call executor_resume with \`{ requestId, response: { action: "answer", content: { ...their answers } } }\`.

- Never claim you approved anything, and never ask anyone but the user to approve.
- Never re-run a program after a refusal, after a decline, or after an approval that got lost. Earlier calls in it may already have taken effect.
- A request from before ky's approval cards has no card and can't be approved any more: cancel it, then do as for a request that is gone.
- If a resume answers not-found or expired, the request is gone. First check with a read-only program whether the action happened, for example by looking in Sent. Then tell the user, and ask again before you try anything new.
- executor_connection: show or change the URL ky reaches Executor at, keeping the token.`;

/** How the agent changes where ky reaches Executor, on the same origin and with the token already connected. */
export type ExecutorRetarget = (url: string) => Promise<{ refused?: string }>;

export function executorExtension(config: ExecutorConfig, gate: ExecutorGate, retarget?: ExecutorRetarget): Extension {
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
        execute: async (args, api, context) => {
          const call: ExecutorCall = (name, more) => executor.call(name, more, context.abortSignal);

          return gate.replied(await call("execute", args), String(api.conversationId), call);
        }
      }),
      defineTool({
        name: "executor_resume",
        description:
          "Answer an Executor program that paused for input, or decline or cancel one that paused for approval, on the user's word. You can't approve: only the user's tap on ky's card does.",
        parameters: Type.Object({
          requestId: Type.String(),
          response: Type.Object({
            action: Type.Union([Type.Literal("answer"), Type.Literal("decline"), Type.Literal("cancel")], {
              description: "answer a request for input with the user's answers, decline on their no, cancel to stop altogether."
            }),
            content: Type.Optional(
              Type.Record(
                Type.String(),
                // What an MCP elicitation answer holds per field.
                Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())]),
                { description: "The user's answers, when Executor asked for input." }
              )
            )
          })
        }),
        replay: "unsafe",
        execute: async ({ requestId, response }, api, context) => {
          const conversation = String(api.conversationId);
          const refused = gate.beforeResume(requestId, response.action, conversation);

          if (refused) return toolReply(`Not sent: ${refused}`, true);
          const call: ExecutorCall = (name, more) => executor.call(name, more, context.abortSignal);
          // Executor takes an answer to a request for input as accept with its content.
          const action = response.action === "answer" ? "accept" : response.action;
          const result = await call("resume", { requestId, response: response.content ? { action, content: response.content } : { action } });

          gate.resumed(requestId);

          return gate.replied(result, conversation, call);
        }
      }),
      ...(retarget ? [connectionTool(config.url, retarget)] : [])
    ]
  });
}

/**
 * The agent's way to edit the connection from the chat. It changes only
 * the path and query: a new origin would send the token to another host, so
 * that stays in Settings.
 */
function connectionTool(current: string, retarget: ExecutorRetarget) {
  return defineTool({
    name: "executor_connection",
    description: `Show or change the URL ky reaches Executor at (now ${current}), keeping the connected token. Only the path and query can change, on the same origin. Approvals are always the user's tap on a card in the chat, and ky ignores any elicitation_mode in the URL. ky tests the new URL before keeping it. Change it only when the user asks.`,
    parameters: Type.Object({ url: Type.Optional(Type.String({ description: "The new URL. Leave out to only show the current one." })) }),
    replay: "safe",
    execute: async (args) => {
      if (args.url === undefined) return { output: [{ type: "text", text: `Executor is connected at ${current}.` }] };

      const { refused } = await retarget(args.url);

      return refused
        ? { output: [{ type: "text", text: `Not changed: ${refused}` }], isError: true }
        : { output: [{ type: "text", text: `Executor is now connected at ${args.url.trim()}. Its tools reconnect there on their next call.` }] };
    }
  });
}

/** Executor's address: https, or http on localhost for a local Executor. */
function checkUrl(url: string): string | undefined {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a URL. Paste Executor's MCP address, like https://mcp.executor.sh/mcp.";
  }

  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    return undefined;
  }

  return "Executor's address must start with https://.";
}

/** Whether two URLs share an origin; undefined when `next` is no URL, which connect then refuses. */
function sameOrigin(current: string, next: string): boolean | undefined {
  try {
    return new URL(current).origin === new URL(next).origin;
  } catch {
    return undefined;
  }
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

  /**
   * Sign in to Executor at `url` with `token` and list its tools; keep it only if that works, else `{ refused }`.
   * An empty token keeps the one already connected, so Settings can change the URL alone.
   */
  async connect(url: string, token: string): Promise<{ refused?: string }> {
    const kept = token.trim() === "" ? (await this.#vault().executor(this.#id))?.token : undefined;
    const connection = { url: url.trim(), token: kept ?? token.trim() };

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

  /** Change the URL on the same origin, keeping the connected token; anything else is `{ refused }`. */
  async retarget(url: string): Promise<{ refused?: string }> {
    const connection = await this.#vault().executor(this.#id);

    if (!connection) return { refused: "Executor is not connected. Connect it in Settings › Tools › Executor." };

    if (sameOrigin(connection.url, url.trim()) === false) {
      return { refused: `ky only changes the path and query here, on ${new URL(connection.url).origin}. Change the host in Settings › Tools › Executor.` };
    }

    return this.connect(url, "");
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
