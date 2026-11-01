import type { AssistantMessage, ImageContent, JsonObject, JsonValue, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { EntryDraft, EntryRecord } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { withoutLateNote } from "./late";

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

export const TO_SPECIALISTS = "to-specialists";

export const SPECIALIST_REPLY = "specialist-reply";

export const LOOK_POST = "look";

const LookPostData = Schema.Struct({
  text: Schema.String,
  cards: Schema.optionalKey(Schema.String),
  /** The delivery this post is, which the user's 👍 or 👎 on it names. */
  item: Schema.optionalKey(Schema.String)
});

type LookPostData = typeof LookPostData.Type;

export function lookPost(text: string, timestamp: number, cards?: string, item?: string): EntryDraft {
  const carded: LookPostData = cards === undefined ? { text } : { text, cards };
  const data: LookPostData = item === undefined ? carded : { ...carded, item };

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

const ToSpecialistsData = Schema.Struct({ to: Schema.Array(Schema.String) });

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
  /** A post's delivery id, which the user's 👍 or 👎 names. */
  readonly post?: string;
  /**
   * Where the model's context starts again: "summary" where pi compacted what came before into the summary this
   * message holds, "reset" where the context was reset. The chat shows it as a divider; what came before is still
   * the user's to page back to.
   */
  readonly boundary?: "summary" | "reset";
};

/** The user's own parts: a late message's note is the model's (late.ts), not part of what they wrote. */
function userParts(content: UserMessage["content"]): PiMessagePart[] {
  const parts: readonly (TextContent | ImageContent)[] = Array.isArray(content) ? content : [{ type: "text", text: content }];

  return parts.flatMap((part): PiMessagePart[] => {
    if (part.type !== "text") return [part];
    const text = withoutLateNote(part.text);

    if (text === part.text) return [part];

    return text === "" ? [] : [{ ...part, text }];
  });
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

      const posted: PiMessage = { ...projectMessage(kySays([...postedCards(String(entry.id), data.cards), ...text], timestamp), String(entry.id)), posted: true };

      return data.item === undefined ? posted : { ...posted, post: data.item };
    })
  );
}

function toSpecialists(entry: EntryRecord, message: Message): PiMessage {
  const projected = projectMessage(message, String(entry.id));

  const parts = projected.parts.map((part) => (part.type === "text" ? { ...part, text: part.text.replace(FOR_MARK, "") } : part)).filter((part) => part.type !== "text" || part.text !== "");

  const to = Schema.decodeUnknownOption(ToSpecialistsData)(entry.data);

  return Option.isSome(to) ? { ...projected, parts, to: to.value.to } : { ...projected, parts };
}

/** pi's compaction marker: the summary the model reads in place of what came before it. */
export const COMPACTION = "pi.compaction";

/** The summary inside a compaction marker's text, without pi's framing around it. */
function summaryOf(text: string): string {
  const open = text.indexOf("<summary>");
  const close = text.lastIndexOf("</summary>");

  return (open < 0 ? text : text.slice(open + "<summary>".length, close > open ? close : undefined)).trim();
}

export function projectEntry(entry: EntryRecord): PiMessage | undefined {
  const message = entry.model?.[0];

  if (entry.kind === "pi.reset") return { id: String(entry.id), role: "notice", boundary: "reset", parts: [{ type: "text", text: "Context reset" }], timestamp: message?.timestamp ?? 0 };

  if (entry.kind === COMPACTION) {
    const text = (message?.role === "user" ? userParts(message.content) : []).map((part) => (part.type === "text" ? part.text : "")).join("");

    return { id: String(entry.id), role: "notice", boundary: "summary", parts: [{ type: "text", text: summaryOf(text) }], timestamp: message?.timestamp ?? 0 };
  }

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
