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

export class NoSuchChat extends Schema.TaggedError<NoSuchChat>()("NoSuchChat", { chat: Schema.String }) implements Refusable {
  get refusal(): string {
    return `No chat ${JSON.stringify(this.chat)} in the user's list: inspect with no chat lists every chat and its id.`;
  }
}

export class ThisChat extends Schema.TaggedError<ThisChat>()("ThisChat", {}) implements Refusable {
  get refusal(): string {
    return "That is this chat: answer here.";
  }
}

export class NotTheUsersTurn extends Schema.TaggedError<NotTheUsersTurn>()("NotTheUsersTurn", { title: Schema.String }) implements Refusable {
  get refusal(): string {
    return `"${this.title}" exists, but this turn was not started by the user, so it sends only to chats this chat opened (chats never keep each other going). Tell the user here; their next message here can send it.`;
  }
}
