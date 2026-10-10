/**
 * VibeProxy, faked: the local model server on the user's computer. The
 * overlay's tunnel in src/tests/stack.ts switches between these per object;
 * the worker e2e tests' runner and the CLI harness's real `ky runner run` reach
 * `fakeVibeProxy` on a machine's port over the pipe.
 *
 * `refusingVibeProxy` is the Mac away: the tunnel refuses every connection.
 * `fakeVibeProxy` is the Mac online: VibeProxy's Messages API, answering
 * `Title: "Claude <model> (thinking <type>)"` and the user's text on the
 * next line, so a test can see which model answered and how it was asked to
 * think. A user text containing "fail" gets a 400. `multiply N` calls the
 * tests' `multiply` tool, and a tool's result is answered `tool said:
 * <result>`, so a turn uses a tool.
 *
 * Two more paths are for the pipe's own tests: `/slow` streams a line every
 * 50ms until it is cancelled, and `/hang` never answers.
 */

/** The key the fake wants, as VibeProxy checks its own. */
export const VIBEPROXY_KEY = "test-vibeproxy-key";

/** The port the local stack's machines share VibeProxy on: off 8317, where a real one may be listening. */
export const VIBEPROXY_TEST_PORT = 18_317;

export function refusingVibeProxy(): Response {
  throw new Error("connect ECONNREFUSED 127.0.0.1:8317");
}

type Part = { type: string; text?: string; content?: string | Part[] };

type MessagesBody = {
  model: string;
  thinking?: { type: string };
  messages: Array<{ role: string; content: string | Part[] }>;
};

const textOf = (content: string | Part[] | undefined): string =>
  Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : (content ?? "");

export async function fakeVibeProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/slow") return slow();

  if (url.pathname === "/hang") return new Promise(() => {});

  if (request.headers.get("x-api-key") !== VIBEPROXY_KEY) return new Response("Wrong VibeProxy key.", { status: 401 });

  if (url.pathname === "/v1/models") return Response.json({ data: [], has_more: false });

  if (url.pathname !== "/v1/messages") return new Response("Not found", { status: 404 });

  // SAFETY: pi-ai's Anthropic API sends a Messages API body.
  const body = (await request.json()) as MessagesBody;
  const content = body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  const result = Array.isArray(content) ? content.find((part) => part.type === "tool_result") : undefined;
  const text = textOf(content);
  const multiply = /^multiply (\d+)$/.exec(text);

  if (text.includes("fail")) {
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "fake VibeProxy failure" } },
      { status: 400 }
    );
  }

  const answer = result ? `tool said: ${textOf(result.content)}` : `Title: "Claude ${body.model} (thinking ${body.thinking?.type ?? "off"})"\n${text}`;
  const usage = { input_tokens: 1, output_tokens: 1 };

  const block: Array<[string, unknown]> =
    multiply && !result
      ? [
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fake", name: "multiply", input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ value: Number(multiply[1]) }) } }]
        ]
      : [
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } }]
        ];

  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage
        }
      }
    ],
    ...block,
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: multiply && !result ? "tool_use" : "end_turn", stop_sequence: null }, usage }],
    ["message_stop", { type: "message_stop" }]
  ];

  const sse = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
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
