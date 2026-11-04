import { type Static, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import { toolReply as reply } from "../core/reply";
import type { ChatList } from "./chats";
import { type ChatRow, NoSuchChat, NotAChat, NothingToStart, NothingToSteer, NotTheUsersTurn, OpenedByAnother, type Opener, ThisChat } from "./contract";

const LAST_CHARS = 16_000;

const LISTED = 50;

type ChatsParts = {
  readonly chats: Pick<ChatList, "list" | "touch" | "rename" | "archive">;
  readonly openedFor: (request: string) => string | undefined;
  readonly openedBy: (session: string) => string | null;
  readonly open: (opener: Opener) => Promise<string>;
  readonly steer: (session: string, content: string, requestId: string) => Promise<void>;
  readonly busy: (session: string) => Promise<boolean>;
  readonly latest: (session: string) => string | null;
  readonly chat: (session: string) => boolean;
  /** Whether the turn running in `session` was started by the user's own message, not a report or another chat's. */
  readonly userStarted: (session: string) => boolean;
};

const Args = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("steer"), Type.Literal("inspect")]),
  chat: Type.Optional(Type.String({ description: `A chat's id, from create or inspect; the main chat is ${ROOT_SESSION}.` })),
  message: Type.Optional(Type.String()),
  title: Type.Optional(Type.String({ description: "create: the chat's name in the user's list; named from the message when left out." }))
});

/** The main chat has no row in the chat list; it reads as one, never archived and opened by nobody. */
const MAIN: ChatRow = { session: ROOT_SESSION, title: "main chat", created_at: 0, updated_at: 0, archived_at: null, opened_by: null, opened_request: null };

const shown = (row: ChatRow) => row.title || "untitled";

/** Every chat in the user's list, the main chat first, then the side chats newest first. */
const everyChat = (parts: ChatsParts): readonly ChatRow[] => [MAIN, ...parts.chats.list()];

const find = (parts: ChatsParts, session: string | undefined) => everyChat(parts).find((row) => row.session === session);

function senderName(parts: ChatsParts, from: string): string {
  const row = find(parts, from);

  return (row ? shown(row) : "a chat").replaceAll(/["\]\n]/g, " ");
}

const fromOpener = (name: string, message: string) => `[chat "${name}": it opened this chat for the user and steers it; answer here, where the user reads it] ${message}`;

const fromAnother = (name: string, message: string) => `[chat "${name}": the user asked it to send this here; answer here, where the user reads it] ${message}`;

async function line(parts: ChatsParts, from: string, row: ChatRow): Promise<string> {
  const marks = [
    row.session === from ? "this chat" : null,
    row.opened_by === from ? "opened by this chat" : row.opened_by === null ? null : `opened by "${senderName(parts, row.opened_by)}"`,
    (await parts.busy(row.session)) ? "working" : "idle",
    row.session === ROOT_SESSION ? null : `updated ${new Date(row.updated_at).toISOString()}`,
    row.archived_at === null ? null : "archived"
  ].filter((mark) => mark !== null);

  return `${row.session} "${shown(row)}", ${marks.join(", ")}`;
}

async function list(parts: ChatsParts, from: string): Promise<ToolExecutionResult> {
  const rows = everyChat(parts);
  const lines = await Promise.all(rows.slice(0, LISTED).map((row) => line(parts, from, row)));
  const more = rows.length > LISTED ? `\n…and ${rows.length - LISTED} older chats; chat_search finds what was said in them.` : "";

  return reply(`The user's chats:\n${lines.join("\n")}${more}`);
}

async function inspect(parts: ChatsParts, row: ChatRow): Promise<ToolExecutionResult> {
  const state = (await parts.busy(row.session)) ? "working" : "idle";
  const text = parts.latest(row.session);

  if (text === null) return reply(`"${shown(row)}" is ${state}; no message from ky in it yet.`);
  const chars = Array.from(text);
  const said = chars.length > LAST_CHARS ? `${chars.slice(0, LAST_CHARS).join("")}…[truncated; ${chars.length} chars total]` : text;

  return reply(`"${shown(row)}" is ${state}. ky's latest message there:\n${said}`);
}

async function create(parts: ChatsParts, from: string, task: number, message: string, title: string | undefined): Promise<ToolExecutionResult> {
  const request = `chat-create:${from}:${task}`;
  const session = parts.openedFor(request) ?? (await parts.open({ by: from, request }));

  if (title?.trim()) parts.chats.rename(session, title);
  parts.chats.touch(session, message);
  await parts.steer(session, fromOpener(senderName(parts, from), message), request);

  return reply(`Opened chat ${session}; its agent answers there, where the user reads it. Use inspect to see how it is going.`);
}

/**
 * Give `row` a message. A chat it opened takes one any time. Any other chat takes one only in a turn the user
 * started: a turn another chat's message started can then send nowhere but its own chats, which send nothing,
 * so two chats never keep waking each other.
 */
async function steer(parts: ChatsParts, from: string, task: number, row: ChatRow, message: string): Promise<ToolExecutionResult> {
  const opener = row.opened_by === from;

  if (row.session === from) return reply(new ThisChat().refusal, true);

  if (!opener && !parts.userStarted(from)) return reply(new NotTheUsersTurn({ title: shown(row) }).refusal, true);

  if (row.archived_at !== null) parts.chats.archive(row.session, false);

  if (row.session !== ROOT_SESSION) parts.chats.touch(row.session, message);
  const name = senderName(parts, from);
  await parts.steer(row.session, opener ? fromOpener(name, message) : fromAnother(name, message), `chat-steer:${from}:${task}`);

  return reply(`Sent to "${shown(row)}"; its agent answers there, where the user reads it.`);
}

async function call(parts: ChatsParts, args: Static<typeof Args>, from: string, task: number): Promise<ToolExecutionResult> {
  if (!parts.chat(from)) return reply(new NotAChat().refusal, true);

  if (args.action === "inspect" && args.chat === undefined) return list(parts, from);
  const row = find(parts, args.chat);

  // Reading is safe from any chat; only a chat with the user, not one another chat opened, sends.
  if (args.action === "inspect") return row ? inspect(parts, row) : reply(new NoSuchChat({ chat: args.chat ?? "" }).refusal, true);

  if (parts.openedBy(from) !== null) return reply(new OpenedByAnother().refusal, true);
  const message = args.message?.trim() ?? "";

  if (args.action === "create") return message === "" ? reply(new NothingToStart().refusal, true) : create(parts, from, task, message, args.title);

  if (!row) return reply(new NoSuchChat({ chat: args.chat ?? "" }).refusal, true);

  return message === "" ? reply(new NothingToSteer().refusal, true) : steer(parts, from, task, row, message);
}

export function chatsExtension(parts: ChatsParts): Extension {
  return defineExtension({
    name: "chats",
    tools: [
      defineTool({
        name: "chats",
        description:
          "Find, read and run the user's chats: the main chat and every side chat in their list, each a full ky chat. " +
          "inspect (chat?): with no chat, every chat with its id, title, who opened it, and whether it is working; with a chat, whether it is working and ky's latest message there. " +
          "create (message, title?): open a side chat and give its agent the message, which it starts on there; say what to do, as to a colleague. " +
          "steer (chat, message): send a chat a message: it joins the turn it is in, or starts one. A chat this one opened takes one any time; any other chat only when the user asked in this turn. " +
          "When the user names a chat, inspect to find its id by title. Answers stay in that chat and do not come back to you: end the turn, and inspect later when the user asks.",
        parameters: Args,
        replay: "safe",
        execute: (args, api) => call(parts, args, String(api.conversationId), api.taskId)
      })
    ]
  });
}
