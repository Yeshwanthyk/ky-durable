import type {
  AssistantMessage,
  ImageContent,
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
      readonly arguments: JsonValue;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly content: readonly (TextContent | ImageContent)[];
      readonly details?: JsonValue;
      readonly error: boolean;
    };

/** One display-ready message projected from a pi transcript entry. */
export type PiMessage = {
  /** The pi entry id, or `live` for the message being streamed. */
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "notice";
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

  if (entry.kind === "pi.system" || message === undefined) return undefined;

  return projectMessage(message, String(entry.id));
}

export function projectEntries(entries: readonly EntryRecord[]): PiMessage[] {
  return entries.flatMap((entry) => {
    const message = projectEntry(entry);

    return message ? [message] : [];
  });
}
