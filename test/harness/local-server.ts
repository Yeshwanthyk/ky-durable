import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fakeLocalServer, LOCAL_SERVER_TEST_PORT } from "../fakes/local-server.ts";

/**
 * A local server on the harness's machines: the fake (test/fakes/local-server.ts)
 * served on 127.0.0.1:LOCAL_SERVER_TEST_PORT, where a runner started with
 * KY_RUNNER_PORTS sharing that port forwards ky's requests over the pipe.
 */

export type LocalServer = {
  /** The paths asked so far, query included, in order. */
  asked: string[];
  /** The paths whose asker hung up before the answer ended. */
  dropped: string[];
  close: () => Promise<void>;
};

/** The request's body as text. */
async function bodyOf(request: IncomingMessage): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];

  // SAFETY: a node request with no encoding set reads as Buffers, which are Uint8Arrays.
  for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks).toString("utf8");
}

function headersOf(request: IncomingMessage): Headers {
  const headers = new Headers();

  for (let at = 0; at < request.rawHeaders.length; at += 2) headers.append(request.rawHeaders[at]!, request.rawHeaders[at + 1]!);

  return headers;
}

/** Write `body` out as it comes; the asker hanging up ends it. */
async function streamTo(response: ServerResponse, body: ReadableStream<Uint8Array> | null): Promise<void> {
  const reader = body?.getReader();
  response.on("close", () => void reader?.cancel());

  for (let read = await reader?.read(); read && !read.done && !response.destroyed; read = await reader!.read()) response.write(read.value);
  response.end();
}

export async function serveLocalServer(): Promise<LocalServer> {
  const asked: string[] = [];
  const dropped: string[] = [];

  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    asked.push(path);
    response.on("close", () => {
      if (!response.writableFinished) dropped.push(path);
    });

    const answer = await fakeLocalServer(new Request(`http://127.0.0.1:${LOCAL_SERVER_TEST_PORT}${path}`, { method: request.method, headers: headersOf(request), body: await bodyOf(request) }));

    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    await streamTo(response, answer.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(LOCAL_SERVER_TEST_PORT, "127.0.0.1", resolve);
  });

  return {
    asked,
    dropped,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}
