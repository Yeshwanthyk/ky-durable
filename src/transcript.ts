import type {
  AssistantMessage,
  ImageContent,
  JsonObject,
  JsonValue,
  Message,
  TextContent,
  UserMessage
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

/**
 * This app's display model for a transcript. The harness returns pi's own
 * entries; the UI folds them into these messages, on the server for a
 * snapshot and in the browser for streamed events.
 */
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

/** The user's message in a chat, addressed to specialists rather than ky: a passive entry that starts no run. */
export const TO_SPECIALISTS = "ky.to-specialists";

/** A specialist's own reply in a chat, posted as a passive entry: ky does not pass it on, and it starts nothing. */
export const SPECIALIST_REPLY = "ky.specialist-reply";

export type ToSpecialistsData = { to: string[] };

/** ky reads the user's message to specialists after this mark, so it knows the message is not for it. */
export const FOR_MARK = /^\[for (@[a-z0-9-]+(?:, @[a-z0-9-]+)*)\] ?/;

export type SpecialistReplyData = { readonly specialist: string; readonly text: string; readonly failed: boolean };

/** One display-ready message projected from a pi transcript entry. */
export type PiMessage = {
  /** The pi entry id, or `live` for the message being streamed. */
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "notice" | "specialist";
  /** A specialist's reply: who wrote it. */
  readonly from?: string;
  /** The user's message to specialists: who it is for. */
  readonly to?: readonly string[];
  readonly parts: readonly PiMessagePart[];
  readonly timestamp: number;
  readonly stopReason?: string;
  readonly error?: string;
};

function userParts(content: UserMessage["content"]): PiMessagePart[] {
  return Array.isArray(content)
    ? content
    : [{ type: "text", text: content }];
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

/** Project one pi-ai message. */
export function projectMessage(message: Message, id: string): PiMessage {
  switch (message.role) {
    case "system":
      // pi records prompt changes as system entries; the UI does not show them.
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

      return message.errorMessage === undefined
        ? assistant
        : { ...assistant, error: message.errorMessage };
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
        parts: [
          message.details === undefined
            ? { ...result, error: message.isError }
            : { ...result, details: message.details, error: message.isError }
        ],
        timestamp: message.timestamp
      };
    }
  }
}

/**
 * Project one transcript entry. Entries that carry a model message become
 * that message; a reset becomes a notice; system-prompt entries and other
 * bookkeeping have no projection.
 */
export function projectEntry(entry: EntryRecord): PiMessage | undefined {
  const message = entry.model?.[0];

  if (entry.kind === "pi.reset") {
    return {
      id: String(entry.id),
      role: "notice",
      parts: [{ type: "text", text: "Context reset" }],
      timestamp: 0
    };
  }

  if (entry.kind === SPECIALIST_REPLY) {
    // SAFETY: only the group-reply task writes this kind, with SpecialistReplyData.
    const data = entry.data as SpecialistReplyData;

    const reply: PiMessage = {
      id: String(entry.id),
      role: "specialist",
      from: data.specialist,
      parts: [{ type: "text", text: data.text }],
      timestamp: message?.timestamp ?? 0
    };

    return data.failed ? { ...reply, error: data.text } : reply;
  }

  if (entry.kind === "pi.system" || message === undefined) return undefined;

  if (entry.kind === TO_SPECIALISTS) {
    // SAFETY: only the group desk writes this kind, with ToSpecialistsData.
    const projected = projectMessage(message, String(entry.id));
    const parts = projected.parts
      .map((part) => (part.type === "text" ? { ...part, text: part.text.replace(FOR_MARK, "") } : part))
      .filter((part) => part.type !== "text" || part.text !== "");

    return { ...projected, parts, to: (entry.data as ToSpecialistsData).to };
  }

  return projectMessage(message, String(entry.id));
}

export function projectEntries(entries: readonly EntryRecord[]): PiMessage[] {
  return entries.flatMap((entry) => {
    const message = projectEntry(entry);

    return message ? [message] : [];
  });
}
