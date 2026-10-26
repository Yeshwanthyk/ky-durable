import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";

export const CHAT_TABLES = { chats: "ky_chats", main: "ky_main_chat" } as const;

export const ChatRow = Schema.Struct({
  session: Schema.String,
  title: Schema.String,
  created_at: Schema.Number,
  updated_at: Schema.Number,
  archived_at: Schema.NullOr(Schema.Number),
  opened_by: Schema.NullOr(Schema.String),
  opened_request: Schema.NullOr(Schema.String)
});

export type ChatRow = typeof ChatRow.Type;

export type Opener = { readonly by: string; readonly request: string };

export class NotAChat extends Schema.TaggedError<NotAChat>()("NotAChat", {}) implements Refusable {
  get refusal(): string {
    return "Only a chat with the user runs other chats.";
  }
}

export class OpenedByAnother extends Schema.TaggedError<OpenedByAnother>()("OpenedByAnother", {}) implements Refusable {
  get refusal(): string {
    return "Another chat opened this one, so this one runs none: answer here.";
  }
}

export class NothingToStart extends Schema.TaggedError<NothingToStart>()("NothingToStart", {}) implements Refusable {
  get refusal(): string {
    return "Nothing to start it on: give a message.";
  }
}

export class NothingToSteer extends Schema.TaggedError<NothingToSteer>()("NothingToSteer", {}) implements Refusable {
  get refusal(): string {
    return "Nothing to steer it with: give a message.";
  }
}

export class NotOpenedHere extends Schema.TaggedError<NotOpenedHere>()("NotOpenedHere", { chat: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No chat ${JSON.stringify(this.chat)} that this chat opened: inspect lists them.`;
  }
}

export type ChatsRefusal = NotAChat | OpenedByAnother | NothingToStart | NothingToSteer | NotOpenedHere;
