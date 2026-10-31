import { type AiCall, type Reply, type Script, type WireMessage, wireText } from "./ai";

/**
 * Anthropic's Messages API and OpenAI's Responses API, the api-key vendors
 * that don't speak chat completions, and ChatGPT's Codex backend, which speaks
 * the Responses API for a ChatGPT sign-in, answering text from the same script as
 * test/fakes/ai.ts. Each wants its own key and answers any other with 401, as
 * the vendors do. They answer a reply that calls a tool with 501: only
 * Workers AI and OpenCode Go run the tests' tools.
 */

export const ANTHROPIC_KEY = "sk-ant-api03-test";

export const OPENAI_KEY = "sk-proj-test";

export const CHATGPT_ACCOUNT = "acct-test";

type Claims = Readonly<Record<string, string | Readonly<Record<string, string>>>>;

const base64url = (value: Claims) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** A ChatGPT access token as the sign-in hands it out: a JWT naming the account, which Codex wants as a header too. */
export const CHATGPT_TOKEN = `${base64url({ alg: "none" })}.${base64url({ "https://api.openai.com/auth": { chatgpt_account_id: CHATGPT_ACCOUNT } })}.sig`;

const OPENAI = { path: "/v1/responses", authorized: (request: Request) => request.headers.get("authorization") === `Bearer ${OPENAI_KEY}` };

const CODEX = {
  path: "/backend-api/codex/responses",
  authorized: (request: Request) => request.headers.get("authorization") === `Bearer ${CHATGPT_TOKEN}` && request.headers.get("chatgpt-account-id") === CHATGPT_ACCOUNT
};

type Part = { readonly type: string; readonly text?: string };

type Turn = { readonly role: string; readonly content: string | Part[] };

/** `fetch`, with Anthropic's and OpenAI's hosts answered here and every other request passed to `otherwise`. */
export function vendors(script: Script, calls: AiCall[], otherwise: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);

    switch (new URL(request.url).host) {
      case "api.anthropic.com":
        return messages(request, script, calls);
      case "api.openai.com":
        return responses(request, script, calls, OPENAI);
      case "chatgpt.com":
        return responses(request, script, calls, CODEX);
      default:
        return otherwise(request);
    }
  };
}

async function messages(request: Request, script: Script, calls: AiCall[]): Promise<Response> {
  if (new URL(request.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 });

  // SAFETY: pi's anthropic-messages API posts a Messages API body.
  const body = (await request.json()) as {
    model: string;
    system?: string | Part[];
    messages: readonly Turn[];
    thinking?: { readonly type: string };
  };

  const wire: WireMessage[] = [
    ...(body.system === undefined ? [] : [{ role: "system" as const, content: wireText(parts(body.system)) }]),
    ...body.messages.map((turn) => ({ role: role(turn.role), content: parts(turn.content) }))
  ];

  record(request, calls, body.model, wire, body.thinking?.type ?? null);

  if (request.headers.get("x-api-key") !== ANTHROPIC_KEY) {
    return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
  }

  const text = answered(script(wire));

  if (text instanceof Response) return text;
  const usage = { input_tokens: 10, output_tokens: 1 };

  return sse([
    ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage }],
    ["message_stop", { type: "message_stop" }]
  ]);
}

async function responses(request: Request, script: Script, calls: AiCall[], api: typeof OPENAI): Promise<Response> {
  if (new URL(request.url).pathname !== api.path) return new Response("not found", { status: 404 });

  // SAFETY: pi's openai-responses API posts a Responses API body; tool calls and results are items without a role.
  const body = JSON.parse(await textOf(request)) as {
    model: string;
    input: ReadonlyArray<Partial<Turn>>;
    reasoning?: { readonly effort?: string };
  };

  const wire: WireMessage[] = body.input.flatMap((item) =>
    item.role === undefined || item.content === undefined ? [] : [{ role: role(item.role), content: parts(item.content) }]
  );

  record(request, calls, body.model, wire, body.reasoning?.effort ?? null);

  if (!api.authorized(request)) {
    return Response.json(
      { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } },
      { status: 401 }
    );
  }

  const text = answered(script(wire));

  if (text instanceof Response) return text;
  const item = { type: "message", id: "msg_fake", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const usage = { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

  return sse([
    ["response.created", { type: "response.created", response: { id: "resp_fake", status: "in_progress" } }],
    ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }],
    ["response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
    ["response.completed", { type: "response.completed", response: { id: "resp_fake", status: "completed", usage } }]
  ]);
}

/** A request's body as text. pi zstd-compresses a Codex body where node:zlib can, as the Codex client does, and the backend takes either. */
async function textOf(request: Request): Promise<string> {
  if (request.headers.get("content-encoding") !== "zstd") return request.text();
  const zlib = process.getBuiltinModule("node:zlib");

  return zlib.zstdDecompressSync(new Uint8Array(await request.arrayBuffer())).toString();
}

/** A turn's role as chat completions has it; pi places system-prompt changes as system (or developer) turns. */
function role(given: string): WireMessage["role"] {
  if (given === "system" || given === "developer") return "system";

  return given === "assistant" ? "assistant" : "user";
}

/** A message's content as chat completions carries it. */
function parts(content: string | Part[]): WireMessage["content"] {
  return Array.isArray(content) ? content.map((part) => ({ type: part.type, text: part.text })) : content;
}

function record(request: Request, calls: AiCall[], model: string, wire: readonly WireMessage[], reasoning: string | null): void {
  calls.push({
    url: request.url,
    model,
    system: wire.flatMap((message) => (message.role === "system" ? [wireText(message.content)] : [])).join("\n"),
    headers: Object.fromEntries(request.headers),
    reasoning
  });
}

/** The reply's text, or the failure to answer instead. */
function answered(reply: Reply): string | Response {
  if ("text" in reply) return reply.text;

  if ("status" in reply) return Response.json({ error: { message: reply.error } }, { status: reply.status });

  return Response.json({ error: { message: `The fake vendor answers text only, not a call to ${reply.tool}.` } }, { status: 501 });
}

function sse(events: ReadonlyArray<readonly [string, unknown]>): Response {
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
