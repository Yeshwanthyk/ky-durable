import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

/**
 * A real MCP server standing in for Executor, at the network boundary: ky's
 * MCP client reaches it through `fetch`. Its `execute` tool reads the program
 * as a command:
 *
 * - `hang` runs until the caller cancels it;
 * - `lose-response` runs, then the response is lost on the way back, as when
 *   a timeout or a dropped connection comes after the program ran;
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
  #open = new Map<string, WebStandardStreamableHTTPServerTransport>();
  #refuse = 0;

  constructor(token: string) {
    this.token = token;
  }

  /** Forget every session, as Executor does when one expires. */
  expireSessions(): void {
    this.#open.clear();
  }

  /** Fail the next `count` connection attempts before they reach the server. */
  refuseConnects(count: number): void {
    this.#refuse = count;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);

    if (request.headers.get("Authorization") !== `Bearer ${this.token}`) {
      this.unauthorized++;

      return new Response("Unauthorized", { status: 401 });
    }

    // No standalone event stream: the client does without one.
    if (request.method === "GET") return new Response(null, { status: 405 });

    const body: { method?: string; params?: { arguments?: { code?: string } } } =
      request.method === "POST" ? await request.clone().json() : {};

    const session = request.headers.get("mcp-session-id");
    let transport = session === null ? undefined : this.#open.get(session);

    if (body.method === "initialize") {
      if (this.#refuse > 0) {
        this.#refuse--;
        throw new TypeError("Network connection lost.");
      }

      transport = await this.#session();
    } else if (transport === undefined) {
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

  async #session(): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        this.sessions++;
        this.#open.set(id, transport);
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

        return { content: [{ type: "text", text: `ran ${runs}` }] };
      }
    );
    server.registerTool("skills", { inputSchema: { app: z.string().optional(), name: z.string().optional() } }, async () => ({
      content: [{ type: "text", text: "fake executor apps: calendar (2 skills), github (3 skills)" }]
    }));
    server.registerTool("resume", { inputSchema: { requestId: z.string() } }, async ({ requestId }) => ({
      content: [{ type: "text", text: `fake executor resumed ${requestId}` }]
    }));
    await server.connect(transport);

    return transport;
  }
}
