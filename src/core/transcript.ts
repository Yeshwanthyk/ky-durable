import type { AssistantMessage, ImageContent, JsonObject, JsonValue, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { EntryDraft, EntryRecord } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type PiMessagePart =
  | TextContent
  | ImageContent
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: JsonObject;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly content: readonly (TextContent | ImageContent)[];
      readonly details?: JsonValue;
      readonly error: boolean;
    };

export const TO_SPECIALISTS = "ky.to-specialists";

export const SPECIALIST_REPLY = "ky.specialist-reply";

export const LOOK_POST = "ky.look";

const LookPostData = Schema.Struct({
  text: Schema.String,
  cards: Schema.optionalKey(Schema.String)
});

type LookPostData = typeof LookPostData.Type;

export function lookPost(text: string, timestamp: number, cards?: string): EntryDraft {
  const data: LookPostData = cards === undefined ? { text } : { text, cards };

  const content = cards === undefined ? `[ky posted to the user, unasked] ${text}` : `[ky posted cards to the user, unasked] ${cards}`;

  return {
    kind: LOOK_POST,
    data,
    model: [{ role: "user", content, timestamp }]
  };
}

const PostedCards = Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.MutableJson)));

function postedCards(id: string, cards: string | undefined): AssistantMessage["content"] {
  const parsed = cards === undefined ? [] : Option.getOrElse(Schema.decodeUnknownOption(PostedCards)(cards), () => []);

  return parsed.map((card, index) => ({
    type: "toolCall" as const,
    id: `${id}:card${index}`,
    name: "ui",
    arguments: card
  }));
}

export function kySays(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "",
    provider: "",
    model: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp
  };
}

const ToSpecialistsData = Schema.Struct({ to: Schema.mutable(Schema.Array(Schema.String)) });

export type ToSpecialistsData = typeof ToSpecialistsData.Type;

export const FOR_MARK = /^\[for (@[a-z0-9-]+(?:, @[a-z0-9-]+)*)\] ?/;

const SpecialistReplyData = Schema.Struct({
  specialist: Schema.String,
  text: Schema.String,
  failed: Schema.Boolean
});

export type SpecialistReplyData = typeof SpecialistReplyData.Type;

export type PiMessage = {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "notice" | "specialist";
  readonly from?: string;
  readonly to?: readonly string[];
  readonly parts: readonly PiMessagePart[];
  readonly timestamp: number;
  readonly stopReason?: string;
  readonly error?: string;
  readonly posted?: true;
};

function userParts(content: UserMessage["content"]): PiMessagePart[] {
  return Array.isArray(content) ? content : [{ type: "text", text: content }];
}

function assistantParts(content: AssistantMessage["content"]): PiMessagePart[] {
  return content.map((part): PiMessagePart => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "thinking":
        return { type: "thinking", text: part.thinking };
      case "toolCall":
        return {
          type: "tool-call",
          id: part.id,
          name: part.name,
          arguments: part.arguments
        };
    }
  });
}

export function projectMessage(message: Message, id: string): PiMessage {
  switch (message.role) {
    case "system":
      return { id, role: "notice", parts: [], timestamp: 0 };
    case "user":
      return {
        id,
        role: "user",
        parts: userParts(message.content),
        timestamp: message.timestamp
      };
    case "assistant": {
      const assistant: PiMessage = {
        id,
        role: "assistant",
        parts: assistantParts(message.content),
        timestamp: message.timestamp,
        stopReason: message.stopReason
      };

      return message.errorMessage === undefined ? assistant : { ...assistant, error: message.errorMessage };
    }

    case "toolResult": {
      const result = {
        type: "tool-result",
        id: message.toolCallId,
        name: message.toolName,
        content: message.content
      } as const;

      return {
        id,
        role: "tool",
        parts: [message.details === undefined ? { ...result, error: message.isError } : { ...result, details: message.details, error: message.isError }],
        timestamp: message.timestamp
      };
    }
  }
}

function specialistReply(entry: EntryRecord, timestamp: number): PiMessage | undefined {
  return Option.getOrUndefined(
    Option.map(Schema.decodeUnknownOption(SpecialistReplyData)(entry.data), (data): PiMessage => {
      const reply: PiMessage = { id: String(entry.id), role: "specialist", from: data.specialist, parts: [{ type: "text", text: data.text }], timestamp };

      return data.failed ? { ...reply, error: data.text } : reply;
    })
  );
}

function lookPosted(entry: EntryRecord, timestamp: number): PiMessage | undefined {
  return Option.getOrUndefined(
    Option.map(Schema.decodeUnknownOption(LookPostData)(entry.data), (data): PiMessage => {
      const text = data.text === "" ? [] : [{ type: "text" as const, text: data.text }];

      return { ...projectMessage(kySays([...postedCards(String(entry.id), data.cards), ...text], timestamp), String(entry.id)), posted: true };
    })
  );
}

function toSpecialists(entry: EntryRecord, message: Message): PiMessage {
  const projected = projectMessage(message, String(entry.id));

  const parts = projected.parts.map((part) => (part.type === "text" ? { ...part, text: part.text.replace(FOR_MARK, "") } : part)).filter((part) => part.type !== "text" || part.text !== "");

  const to = Schema.decodeUnknownOption(ToSpecialistsData)(entry.data);

  return Option.isSome(to) ? { ...projected, parts, to: to.value.to } : { ...projected, parts };
}

export function projectEntry(entry: EntryRecord): PiMessage | undefined {
  const message = entry.model?.[0];

  if (entry.kind === "pi.reset") return { id: String(entry.id), role: "notice", parts: [{ type: "text", text: "Context reset" }], timestamp: 0 };

  if (entry.kind === SPECIALIST_REPLY) return specialistReply(entry, message?.timestamp ?? 0);

  if (entry.kind === "pi.system" || message === undefined) return undefined;

  if (entry.kind === LOOK_POST) return lookPosted(entry, message.timestamp);

  if (entry.kind === TO_SPECIALISTS) return toSpecialists(entry, message);

  return projectMessage(message, String(entry.id));
}

export function projectEntries(entries: readonly EntryRecord[]): PiMessage[] {
  return entries.flatMap((entry) => {
    const message = projectEntry(entry);

    return message ? [message] : [];
  });
}
