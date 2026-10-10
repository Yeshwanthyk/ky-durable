import type { JsonValue } from "@earendil-works/pi-ai";
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";

/**
 * An OpenAI chat-completions server, as Workers AI's compat endpoint (behind
 * the AI binding) and OpenCode Go both are, answering each request from a
 * script. It streams as they do: text in small deltas, a tool call as one
 * delta, then a finish reason and usage.
 */

/** A message as the API carries it. */
export type WireMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: string | Array<{ readonly type: string; readonly text?: string }> | null;
};

/** What the script answers: text, one tool call, or a failure with its status. */
export type Reply =
  | { readonly text: string }
  | { readonly tool: string; readonly args: Record<string, JsonValue> }
  | { readonly status: number; readonly error: string };

/** What a request asked, as the wire carries it. */
export type AiCall = {
  readonly url: string;
  readonly model: string;
  /** The system messages' text, joined. */
  readonly system: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The thinking the request asked for, when it sent any. */
  readonly reasoning: string | null;
  /** Each tool's description by its name, as a chat-completions request offered them. */
  readonly tools?: Readonly<Record<string, string>>;
};

export type Script = (messages: readonly WireMessage[]) => Reply;

/** The text of a message's content. */
export function wireText(content: WireMessage["content"]): string {
  if (Array.isArray(content)) return content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("");

  return content ?? "";
}

/**
 * The server as a fetch. `refuse`, asked before each request, is a status to
 * answer instead, as a provider out of credit or rate-limited does.
 */
export function chatCompletions(
  script: Script,
  calls: AiCall[],
  refuse: () => Promise<number | undefined> = async () => undefined
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);

    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });

    // SAFETY: pi's openai-completions API posts a JSON chat-completions body.
    const body = (await request.json()) as {
      model: string;
      messages: WireMessage[];
      reasoning_effort?: string;
      tools?: readonly { function: { name: string; description?: string } }[];
    };

    calls.push({
      url: request.url,
      model: body.model,
      system: body.messages.flatMap((message) => (message.role === "system" ? [wireText(message.content)] : [])).join("\n"),
      headers: Object.fromEntries(request.headers),
      reasoning: body.reasoning_effort ?? null,
      tools: Object.fromEntries((body.tools ?? []).map((tool) => [tool.function.name, tool.function.description ?? ""]))
    });

    const refused = await refuse();

    if (refused !== undefined) return failure(refused, "The fake provider refuses this request.");

    const reply = script(body.messages);

    return "status" in reply ? failure(reply.status, reply.error) : stream(body.model, reply);
  };
}

/** The AI binding, serving `fetch` as `env.AI.fetch()` serves AI Gateway. */
export function fakeAI(fetch: typeof globalThis.fetch): AiBinding {
  return { aiGatewayLogId: null, fetch };
}

function failure(status: number, message: string): Response {
  return Response.json({ error: { message, type: "fake_error" } }, { status });
}

/** What a chunk adds to the answer. */
type Delta = {
  readonly role?: "assistant";
  readonly content?: string;
  readonly tool_calls?: ReadonlyArray<{
    readonly index: number;
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
};

/** The tokens a request used, which the last chunk carries and the others carry as null. */
type Usage = { readonly prompt_tokens: number; readonly completion_tokens: number; readonly total_tokens: number };

/** Text in 3-character deltas a few milliseconds apart, so a test can stop a turn while it streams. */
function stream(model: string, reply: Exclude<Reply, { status: number }>): Response {
  const chunk = (delta: Delta, finish: string | null = null, usage: Usage | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage
    })}\n\n`;

  const deltas =
    "text" in reply
      ? (reply.text.match(/[\s\S]{1,3}/g) ?? [""]).map((content) => chunk({ content }))
      : [
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: { name: reply.tool, arguments: JSON.stringify(reply.args) }
              }
            ]
          })
        ];

  const done = [
    chunk({}, "text" in reply ? "stop" : "tool_calls", { prompt_tokens: 10, completion_tokens: deltas.length, total_tokens: 10 + deltas.length }),
    "data: [DONE]\n\n"
  ];

  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "" })));

      for (const each of deltas) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.enqueue(encoder.encode(each));
      }

      for (const each of done) controller.enqueue(encoder.encode(each));
      controller.close();
    }
  });

  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
