#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * A fake Executor: an MCP server over Streamable HTTP with Executor's three
 * tools, `skills`, `execute` and `resume`, answering canned text. It is the
 * outside boundary ky's executor extension talks to, so the local stack and
 * the worker e2e tests exercise ky's real MCP client.
 *
 *   node test/fakes/executor.ts                  listens on a free port, printed
 *   FAKE_EXECUTOR_PORT=9000 node test/fakes/executor.ts
 *
 * Requests without `Authorization: Bearer ky-stack-executor` get a 401.
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** The token src/tests/wrangler.jsonc gives ky as EXECUTOR_TOKEN. */
export const EXECUTOR_TOKEN = "ky-stack-executor";

const TOOLS = [
  { name: "skills", description: "List apps and skills.", inputSchema: { type: "object" as const } },
  { name: "execute", description: "Run a program.", inputSchema: { type: "object" as const } },
  { name: "resume", description: "Resume a program.", inputSchema: { type: "object" as const } }
];

function answer(name: string, args: Map<string, string>): string {
  if (name === "skills") return "fake executor apps: calendar (2 skills), github (3 skills)";

  if (name === "execute") return `fake executor ran: ${args.get("code") ?? ""}`;

  return `fake executor resumed ${args.get("requestId") ?? "nothing"}`;
}

/** One stateless MCP exchange: a fresh server and transport per request. */
async function handle(request: Request): Promise<Response> {
  if (request.headers.get("Authorization") !== `Bearer ${EXECUTOR_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const server = new Server({ name: "fake-executor", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const args = new Map(Object.entries(call.params.arguments ?? {}).map(([key, value]) => [key, String(value)]));

    return { content: [{ type: "text", text: answer(call.params.name, args) }] };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  await server.connect(transport);

  return transport.handleRequest(request);
}

async function body(message: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of message) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks);
}

/** Listen on 127.0.0.1:`port`, 0 for a free one; resolves with the server and its MCP URL. */
export function startExecutor(port = 0): Promise<{ server: HttpServer; url: string }> {
  const server = createServer(async (incoming, outgoing) => {
    const headers = new Headers();

    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }

    const payload = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await body(incoming);

    const response = await handle(
      new Request(`http://127.0.0.1${incoming.url ?? "/"}`, { method: incoming.method, headers, body: payload })
    );

    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);

    server.listen(port, "127.0.0.1", () => {
      // SAFETY: a server listening on a TCP host and port reports an AddressInfo.
      const { port: bound } = server.address() as AddressInfo;

      resolve({ server, url: `http://127.0.0.1:${bound}/mcp` });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startExecutor(Number(process.env.FAKE_EXECUTOR_PORT ?? 0));
  console.log(`fake executor listening on ${url}`);
}
