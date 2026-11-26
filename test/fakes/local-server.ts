/**
 * A local server on a machine's port, faked for the pipe's own tests: what a runner forwards a request to.
 * `/slow` streams a line every 50ms until it is cancelled, `/hang` never answers, `/hello` answers "hello",
 * and anything else is a 404.
 */

/** The port the tests' machines share it on: off Ollama's 11434, where a real one may be listening. */
export const LOCAL_SERVER_TEST_PORT = 18_317;

export function fakeLocalServer(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/slow") return Promise.resolve(slow());

  if (pathname === "/hang") return new Promise(() => {});

  if (pathname === "/hello") return Promise.resolve(new Response("hello"));

  return Promise.resolve(new Response("Not found", { status: 404 }));
}

/** A line every 50ms, until the reader cancels. */
function slow(): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.enqueue(encoder.encode("tick\n"));
      }
    }),
    { headers: { "content-type": "text/plain" } }
  );
}
