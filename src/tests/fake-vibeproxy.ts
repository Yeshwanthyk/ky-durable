/**
 * Fakes for the VIBEPROXY binding. stack.ts's boundary switches between them
 * per object, so the worker e2e tests and the local stack share them.
 *
 * `refusingVibeProxy` is the Mac away: the tunnel refuses every connection.
 * `fakeVibeProxy` is the Mac online: VibeProxy's Messages API, answering
 * `Title: "Claude <model> (thinking <type>)"` and the user's text on the
 * next line, so a test can see which model answered and how it was asked to
 * think. A user text containing "fail" gets a 400.
 */

const KEY = "test-vibeproxy-key";

export function refusingVibeProxy(): Response {
  throw new Error("connect ECONNREFUSED 127.0.0.1:8317");
}

type MessagesBody = {
  model: string;
  thinking?: { type: string };
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
};

export async function fakeVibeProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.headers.get("x-api-key") !== KEY) return new Response("Wrong VibeProxy key.", { status: 401 });

  if (url.pathname === "/v1/models") return Response.json({ data: [], has_more: false });

  if (url.pathname !== "/v1/messages") return new Response("Not found", { status: 404 });

  // SAFETY: pi-ai's Anthropic API sends a Messages API body.
  const body = (await request.json()) as MessagesBody;
  const content = body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
  const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content;

  if (text.includes("fail")) {
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "fake VibeProxy failure" } },
      { status: 400 }
    );
  }

  const answer = `Title: "Claude ${body.model} (thinking ${body.thinking?.type ?? "off"})"\n${text}`;
  const usage = { input_tokens: 1, output_tokens: 1 };

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
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage }],
    ["message_stop", { type: "message_stop" }]
  ];

  const sse = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}
