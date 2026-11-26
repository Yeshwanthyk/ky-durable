import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  FetchFunction,
  ProviderStreams,
  SimpleStreamOptions
} from "@earendil-works/pi-ai";
import { ToolCallArgumentsStream } from "@earendil-works/pi-ai/utils/streaming-json";
import * as Schema from "effect/Schema";
import {
  CLAUDE_BILLING,
  CLAUDE_SILENCE_MS,
  CLAUDE_STREAM,
  type ClaudeEvent,
  ClaudeLine,
  emptyAnswer,
  failedAnswer,
  silent
} from "./wire";

type Model = Parameters<ProviderStreams["streamSimple"]>[0];

type Context = Parameters<ProviderStreams["streamSimple"]>[1];

const CREDITS = /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/iu;

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(ClaudeLine));

export const billed = (message: string): string =>
  CREDITS.test(message) && !message.startsWith(CLAUDE_BILLING)
    ? `${CLAUDE_BILLING} Anthropic did not accept this request on your Claude plan and wants to charge it to usage credits, so ky stopped. Original error: ${message}`
    : message;

export const lines = (): TransformStream<string, string> => {
  let rest = "";

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const parts = (rest + chunk).split("\n");

      rest = parts.pop() ?? "";

      for (const part of parts.filter((each) => each.trim() !== "")) controller.enqueue(part);
    },
    flush(controller) {
      if (rest.trim() !== "") controller.enqueue(rest);
    }
  });
};

const place = (partial: AssistantMessage, index: number, block: AssistantMessage["content"][number]) => {
  if (index < 0 || index > partial.content.length) throw new Error(`the Claude bridge sent content block ${index} out of order`);

  partial.content[index] = block;
};

const reader = (model: Model) => {
  const partial: AssistantMessage = emptyAnswer(model, "pending");
  const calls = new Map<number, ToolCallArgumentsStream>();

  return (event: ClaudeEvent): AssistantMessageEvent => {
    switch (event.type) {
      case "start":
        return { type: "start", partial };
      case "text_start":
        place(partial, event.contentIndex, { type: "text", text: "" });

        return { ...event, partial };
      case "text_delta": {
        const block = partial.content[event.contentIndex];

        if (block?.type === "text") block.text += event.delta;

        return { ...event, partial };
      }

      case "text_end":
        place(partial, event.contentIndex, { type: "text", text: event.content });

        return { ...event, partial };
      case "thinking_start":
        place(partial, event.contentIndex, { type: "thinking", thinking: "" });

        return { ...event, partial };
      case "thinking_delta": {
        const block = partial.content[event.contentIndex];

        if (block?.type === "thinking") block.thinking += event.delta;

        return { ...event, partial };
      }

      case "thinking_end":
        place(partial, event.contentIndex, { type: "thinking", thinking: event.content });

        return { ...event, partial };
      case "toolcall_start": {
        const { id, name, contentIndex } = event;

        place(partial, contentIndex, { type: "toolCall", id, name, arguments: {} });
        calls.set(contentIndex, new ToolCallArgumentsStream());

        return { type: "toolcall_start", contentIndex, partial };
      }

      case "toolcall_delta": {
        const block = partial.content[event.contentIndex];
        const args = calls.get(event.contentIndex)?.append(event.delta);

        if (block?.type === "toolCall" && args !== undefined) block.arguments = args;

        return { ...event, partial };
      }

      case "toolcall_end":
        place(partial, event.contentIndex, event.toolCall);

        return { ...event, partial };
      case "done":
        return event;
      case "error": {
        const { errorMessage } = event.error;

        return errorMessage === undefined ? event : { ...event, error: { ...event.error, errorMessage: billed(errorMessage) } };
      }
    }
  };
};

const reading = async <T>(quiet: AbortController, silenceMs: number, operation: () => Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const silence = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      quiet.abort();
      reject(new Error("the Claude bridge went silent"));
    }, silenceMs);
  });

  return await Promise.race([operation(), silence]).finally(() => {
    clearTimeout(timer);
  });
};

const relay = async (
  doFetch: FetchFunction,
  silenceMs: number,
  model: Model,
  context: Context,
  options: SimpleStreamOptions | undefined,
  out: AssistantMessageEventStream
) => {
  const quiet = new AbortController();

  try {
    const response = await reading(quiet, silenceMs, async () =>
      doFetch(CLAUDE_STREAM, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: { id: model.id },
          context: { messages: context.messages },
          options: {
            apiKey: options?.apiKey,
            reasoning: options?.reasoning,
            sessionId: options?.sessionId,
            cacheRetention: options?.cacheRetention,
            disableContinuation: options?.disableContinuation
          }
        }),
        signal: options?.signal === undefined ? quiet.signal : AbortSignal.any([options.signal, quiet.signal])
      })
    );

    if (!response.ok || response.body === null) {
      const refusal = await reading(quiet, silenceMs, async () => response.text());

      out.push(failedAnswer(model, "error", `${response.status} ${refusal}`));

      return;
    }

    const read = reader(model);
    const sent = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(lines()).getReader();

    try {
      for (;;) {
        const line = await reading(quiet, silenceMs, async () => sent.read());

        if (line.done) throw new Error("the Claude bridge ended early");

        const heard = decodeLine(line.value);

        if (heard.type !== "alive") {
          const event = read(heard);

          out.push(event);

          if (event.type === "done" || event.type === "error") return;
        }
      }
    } finally {
      sent.cancel().catch(() => undefined);
    }
  } catch (error) {
    if (options?.signal?.aborted === true) {
      out.push(failedAnswer(model, "aborted", "The request was aborted."));

      return;
    }

    if (quiet.signal.aborted) {
      out.push(failedAnswer(model, "error", silent("The Claude container", silenceMs)));

      return;
    }

    const reason = error instanceof Error ? error.message : String(error);

    out.push(failedAnswer(model, "error", `fetch failed: ${reason}`));
  }
};

export const remoteClaudeApi = (doFetch: FetchFunction, silenceMs = CLAUDE_SILENCE_MS): ProviderStreams => {
  const streamSimple: ProviderStreams["streamSimple"] = (model, context, options) => {
    const out = createAssistantMessageEventStream();

    void relay(doFetch, silenceMs, model, context, options, out);

    return out;
  };

  return { stream: streamSimple, streamSimple };
};
