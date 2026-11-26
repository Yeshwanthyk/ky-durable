import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import * as Schema from "effect/Schema";

export const CLAUDE_API = "claude-code";

export const CLAUDE_STREAM = "http://claude/stream";

export const CLAUDE_BILLING = "Claude Code billing:";

export const CLAUDE_SILENCE_MS = 90_000;

export const silent = (source: string, silenceMs: number): string =>
  `${source} went silent: nothing arrived for ${Math.round(silenceMs / 1000)} seconds, so ky stopped this request. Retry, or switch models.`;

export const CLAUDE_MODELS = Object.values(ANTHROPIC_MODELS).map(({ compat: _compat, ...model }) => ({
  ...model,
  api: CLAUDE_API,
  provider: "claude",
  baseUrl: "claude-code:",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}));

const Text = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  textSignature: Schema.optionalKey(Schema.String)
});

const Image = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String
});

const Thinking = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Boolean)
});

const ToolCall = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.JsonObject,
  thoughtSignature: Schema.optionalKey(Schema.String),
  namespace: Schema.optionalKey(Schema.String),
  argumentsError: Schema.optionalKey(Schema.String)
});

const Usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  cacheWrite1h: Schema.optionalKey(Schema.Number),
  reasoning: Schema.optionalKey(Schema.Number),
  totalTokens: Schema.Number,
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number
  })
});

const Assistant = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.mutable(Schema.Array(Schema.Union([Text, Thinking, ToolCall]))),
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  responseModel: Schema.optionalKey(Schema.String),
  responseId: Schema.optionalKey(Schema.String),
  usage: Usage,
  stopReason: Schema.Literals(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
  errorMessage: Schema.optionalKey(Schema.String),
  rawStopReason: Schema.optionalKey(Schema.String),
  timestamp: Schema.Number
});

const Tool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.JsonObject
});

const Content = Schema.Union([Schema.String, Schema.mutable(Schema.Array(Schema.Union([Text, Image])))]);

const Message = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("system"),
    content: Schema.Union([Schema.String, Schema.mutable(Schema.Array(Text))]),
    sections: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
    toolsAdded: Schema.optionalKey(Schema.mutable(Schema.Array(Tool))),
    toolsRemoved: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Struct({ name: Schema.String })))),
    timestamp: Schema.Number
  }),
  Schema.Struct({ role: Schema.Literal("user"), content: Content, timestamp: Schema.Number }),
  Assistant,
  Schema.Struct({
    role: Schema.Literal("toolResult"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    content: Schema.mutable(Schema.Array(Schema.Union([Text, Image]))),
    isError: Schema.Boolean,
    timestamp: Schema.Number
  })
]);

export const ClaudeRequest = Schema.Struct({
  model: Schema.Struct({ id: Schema.String }),
  context: Schema.Struct({ messages: Schema.mutable(Schema.Array(Message)) }),
  options: Schema.Struct({
    apiKey: Schema.String,
    reasoning: Schema.optionalKey(Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"])),
    sessionId: Schema.optionalKey(Schema.String),
    cacheRetention: Schema.optionalKey(Schema.Literals(["none", "short", "long"])),
    disableContinuation: Schema.optionalKey(Schema.Boolean)
  })
});

export const ClaudeEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start") }),
  Schema.Struct({ type: Schema.Literal("text_start"), contentIndex: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("text_delta"), contentIndex: Schema.Int, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text_end"), contentIndex: Schema.Int, content: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking_start"), contentIndex: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("thinking_delta"), contentIndex: Schema.Int, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking_end"), contentIndex: Schema.Int, content: Schema.String }),
  Schema.Struct({ type: Schema.Literal("toolcall_start"), contentIndex: Schema.Int, id: Schema.String, name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("toolcall_delta"), contentIndex: Schema.Int, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("toolcall_end"), contentIndex: Schema.Int, toolCall: ToolCall }),
  Schema.Struct({ type: Schema.Literal("done"), reason: Schema.Literals(["stop", "length", "toolUse", "deferred"]), message: Assistant }),
  Schema.Struct({ type: Schema.Literal("error"), reason: Schema.Literals(["error", "aborted"]), error: Assistant })
]);

export type ClaudeEvent = typeof ClaudeEvent.Type;

export const ClaudeAlive = Schema.Struct({ type: Schema.Literal("alive") });

export const ClaudeLine = Schema.Union([ClaudeEvent, ClaudeAlive]);

export type ClaudeLine = typeof ClaudeLine.Type;

export const wireOf = (event: AssistantMessageEvent): ClaudeEvent => {
  if (event.type === "done" || event.type === "error") return event;

  if (event.type !== "toolcall_start") {
    const { partial: _partial, ...rest } = event;

    return rest;
  }

  const block = event.partial.content[event.contentIndex];

  if (block?.type !== "toolCall") throw new Error("Claude Code started a tool call without its block");

  return { type: event.type, contentIndex: event.contentIndex, id: block.id, name: block.name };
};

export const emptyAnswer = (
  model: { readonly api: string; readonly provider: string; readonly id: string },
  stopReason: AssistantMessage["stopReason"]
): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason,
  timestamp: Date.now()
});

export const failedAnswer = (
  model: Parameters<typeof emptyAnswer>[0],
  reason: "error" | "aborted",
  errorMessage: string
) => ({
  type: "error" as const,
  reason,
  error: { ...emptyAnswer(model, reason), errorMessage }
});
