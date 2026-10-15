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
 * - `answer TEXT` runs and answers TEXT, as a gate's program returns;
 * - `fail TEXT` runs and fails with TEXT;
 * - anything else runs and answers `ran <n>`.
 *
 * `skills` lists two apps and `resume` answers with its request id. Requests
 * without `Authorization: Bearer <token>` get a 401.
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
    const transport = await this.#transport(body.method, request.headers.get("mcp-session-id"));

    if (transport === undefined) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
        { status: 404 }
      );
    }

    const response = await transport.handleRequest(request);

    if (body.method === "tools/call" && body.params?.arguments?.code === "lose-response") {
      await response.text();
      throw new TypeError("Network connection lost.");
    }

    return response;
  };

  /** A new session for `initialize`, unless the connection is refused; else the open session the request names. */
  async #transport(
    method: string | undefined,
    session: string | null
  ): Promise<WebStandardStreamableHTTPServerTransport | undefined> {
    if (method !== "initialize") return session === null ? undefined : this.open.get(session);

    if (this.refuseConnects > 0) {
      this.refuseConnects--;
      throw new TypeError("Network connection lost.");
    }

    return this.#session();
  }

  async #session(): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        this.sessions++;
        this.open.set(id, transport);
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

        const [, command, rest = ""] = /^(answer|fail) ?(.*)$/s.exec(code) ?? [];

        if (command === "answer") return { content: [{ type: "text", text: rest }] };

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
    server.registerTool("resume", { inputSchema: { requestId: z.string() } }, async ({ requestId }) => ({
      content: [{ type: "text", text: `fake executor resumed ${requestId}` }]
    }));
    await server.connect(transport);

    return transport;
  }
}

/** An MCP request, by the fields the fake reads. */
const McpRequest = Type.Object({
  method: Type.Optional(Type.String()),
  params: Type.Optional(
    Type.Object({ arguments: Type.Optional(Type.Object({ code: Type.Optional(Type.String()) })) })
  )
});

async function mcpRequest(request: Request): Promise<Static<typeof McpRequest>> {
  if (request.method !== "POST") return {};
  const value = parsed(await request.clone().text());

  return Value.Check(McpRequest, value) ? value : {};
}
