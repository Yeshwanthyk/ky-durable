import type { JsonValue } from "@earendil-works/pi-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { z } from "zod";
import { parsed } from "./frames";

/**
 * A real MCP server standing in for Executor, at the network boundary: ky's
 * MCP client reaches it through `fetch`. Its `execute` tool reads the program
 * as a command:
 *
 * - `hang` runs until the caller cancels it;
 * - `lose-response` runs, then the response is lost on the way back, as when
 *   a timeout or a dropped connection comes after the program ran;
 * - `answer JSON` runs and returns JSON (TEXT that isn't JSON returns it as a
 *   string), in the envelope the real Executor answers with:
 *   `{ status: "completed", execution: { ok: true, value, toolCalls }, unavailableApps }`;
 * - `throw TEXT` runs a program that throws TEXT: the envelope with
 *   `execution: { ok: false, error: TEXT }`;
 * - `fail TEXT` fails the call itself with TEXT (`isError`);
 * - `approve TEXT` pauses for an approval to do TEXT, as a Gmail send does
 *   (`approve app.tool TEXT` names the tool that asks, as `toolPath`), and
 *   `ask TEXT` pauses for input;
 * - anything else runs and answers `ran <n>`.
 *
 * `skills` lists two apps. `resume` answers a paused request as Executor does:
 * in model mode, the default, any session on the token can answer it; in
 * browser mode (`?elicitation_mode=browser`) only the session that made it,
 * and any other gets `not-found`. Requests without
 * `Authorization: Bearer <token>` get a 401.
 */
export class FakeExecutor {
  /** The token it takes; a test changes it to make ky's token wrong. */
  token: string;
  /** Requests refused for a wrong token. */
  unauthorized = 0;
  /** Programs that ran, by code. */
  readonly runs = new Map<string, number>();
  /** `hang` programs the caller cancelled. */
  cancelled = 0;
  /** Sessions opened, including ones since expired. */
  sessions = 0;
  /** Open sessions by id; a test clears it to expire every session, as Executor does. */
  readonly open = new Map<string, WebStandardStreamableHTTPServerTransport>();
  /** Connection attempts still to fail before they reach the server. */
  refuseConnects = 0;
  /** The URL of each session's `initialize`, as ky connected it. */
  readonly connectedUrls: string[] = [];
  /** Each `resume`'s arguments, as they arrived. */
  readonly resumes: unknown[] = [];
  /** While set, a resume carries out the request and then fails with this text, as a program that acted and threw after. */
  failResumes: string | undefined;
  /** Resumes still to run whose answer is then lost on the way back, as a dropped connection or a timeout after the send. */
  loseResumeAnswers = 0;
  /** While true, a `resume` that arrived waits before it answers, as a slow program does. A flag, not a promise: one made in another request wouldn't wake it. */
  holdResumes = false;
  /** What each paused request will do once accepted, and the session that made it. */
  readonly #paused = new Map<string, { does: string; session: string | undefined }>();
  /** Requests paused so far, for the next one's id. */
  #pauses = 0;
  /** Each session's elicitation mode, from its `initialize` URL. */
  readonly #modes = new Map<string, string>();

  constructor(token: string) {
    this.token = token;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);

    if (request.headers.get("Authorization") !== `Bearer ${this.token}`) {
      this.unauthorized++;

      return new Response("Unauthorized", { status: 401 });
    }

    // No standalone event stream: the client does without one.
    if (request.method === "GET") return new Response(null, { status: 405 });

    const body = await mcpRequest(request);

    if (body.method === "initialize") this.connectedUrls.push(request.url);
    const mode = new URL(request.url).searchParams.get("elicitation_mode") ?? "model";
    const transport = await this.#transport(body.method, request.headers.get("mcp-session-id"), mode);

    if (transport === undefined) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
        { status: 404 }
      );
    }

    const response = await transport.handleRequest(request);

    const lost = body.params?.name === "resume" && this.loseResumeAnswers > 0;

    if (lost) this.loseResumeAnswers--;

    if (body.method === "tools/call" && (lost || body.params?.arguments?.code === "lose-response")) {
      await response.text();
      throw new TypeError("Network connection lost.");
    }

    return response;
  };

  /** A new session for `initialize`, unless the connection is refused; else the open session the request names. */
  async #transport(
    method: string | undefined,
    session: string | null,
    mode: string
  ): Promise<WebStandardStreamableHTTPServerTransport | undefined> {
    if (method !== "initialize") return session === null ? undefined : this.open.get(session);

    if (this.refuseConnects > 0) {
      this.refuseConnects--;
      throw new TypeError("Network connection lost.");
    }

    return this.#session(mode);
  }

  async #session(mode: string): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        this.sessions++;
        this.open.set(id, transport);
        this.#modes.set(id, mode);
      }
    });

    const server = new McpServer({ name: "fake-executor", version: "0.0.0" });
    server.registerTool(
      "execute",
      { inputSchema: { code: z.string() } },
      async ({ code }, extra) => {
        const runs = (this.runs.get(code) ?? 0) + 1;
        this.runs.set(code, runs);

        if (code === "hang") {
          await new Promise<void>((resolve) => extra.signal.addEventListener("abort", () => resolve(), { once: true }));
          this.cancelled++;
        }

        const [, command, rest = ""] = /^(answer|throw|fail|approve|ask) ?(.*)$/s.exec(code) ?? [];

        // `parsed` is undefined for text that isn't JSON; JSON null stays null.
        if (command === "answer") return envelope({ ok: true, value: rest.trim() === "null" ? null : (parsed(rest) ?? rest), toolCalls: [] });

        if (command === "throw") return envelope({ ok: false, error: rest, toolCalls: [] });

        if (command === "approve" || command === "ask") {
          const requestId = `request-${++this.#pauses}`;
          const status = command === "approve" ? "approval-required" : "input-required";
          const [, toolPath, message = rest] = command === "approve" ? (/^(\w+\.[\w.]+) (.*)$/s.exec(rest) ?? []) : [];

          this.#paused.set(requestId, { does: message, session: extra.sessionId });

          return { content: [{ type: "text", text: JSON.stringify(toolPath ? { status, requestId, message, toolPath } : { status, requestId, message }) }] };
        }

        if (command === "fail") return { content: [{ type: "text", text: rest }], isError: true };

        return { content: [{ type: "text", text: `ran ${runs}` }] };
      }
    );
    // An output schema, as the real Executor's tools have: listing it needs a validator that works in Workers.
    server.registerTool(
      "skills",
      { inputSchema: { app: z.string().optional(), name: z.string().optional() }, outputSchema: { apps: z.string() } },
      async () => {
        const apps = "fake executor apps: calendar (2 skills), github (3 skills)";

        return { content: [{ type: "text", text: apps }], structuredContent: { apps } };
      }
    );
    server.registerTool(
      "resume",
      {
        inputSchema: {
          requestId: z.string(),
          response: z.object({ action: z.enum(["accept", "decline", "cancel"]), content: z.record(z.string(), z.unknown()).optional() })
        }
      },
      async (args, extra) => {
        this.resumes.push(args);

        while (this.holdResumes) await new Promise((resolve) => setTimeout(resolve, 10));
        const paused = this.#paused.get(args.requestId);
        const browser = paused !== undefined && this.#modes.get(paused.session ?? "") === "browser";

        // Browser mode keeps a request on the session that made it; model mode lets any session answer.
        if (paused === undefined || (browser && paused.session !== extra.sessionId)) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "unavailable", reason: "not-found" }) }] };
        }

        this.#paused.delete(args.requestId);

        if (this.failResumes !== undefined) return { content: [{ type: "text", text: this.failResumes }], isError: true };
        const done = args.response.action === "accept" ? { status: "completed", result: `did ${paused.does}` } : { status: "declined" };

        return { content: [{ type: "text", text: JSON.stringify(done) }] };
      }
    );
    await server.connect(transport);

    return transport;
  }
}

/** How a program ran, inside Executor's envelope: what it returned, or what it threw. */
type Execution = { ok: true; value: JsonValue; toolCalls: [] } | { ok: false; error: string; toolCalls: [] };

/** A program's run as Executor answers it. */
function envelope(execution: Execution) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ status: "completed", execution, unavailableApps: [] }) }] };
}

/** An MCP request, by the fields the fake reads. */
const McpRequest = Type.Object({
  method: Type.Optional(Type.String()),
  params: Type.Optional(
    Type.Object({ name: Type.Optional(Type.String()), arguments: Type.Optional(Type.Object({ code: Type.Optional(Type.String()) })) })
  )
});

async function mcpRequest(request: Request): Promise<Static<typeof McpRequest>> {
  if (request.method !== "POST") return {};
  const value = parsed(await request.clone().text());

  return Value.Check(McpRequest, value) ? value : {};
}
