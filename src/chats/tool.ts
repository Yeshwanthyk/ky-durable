import { type Static, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, GenerationTask, hook, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import { toolReply as reply } from "../core/reply";
import { textOf } from "../skills/contract";
import type { ChatList } from "./chats";
import {
  type ChatRow,
  NoSuchChat,
  NotAChat,
  NothingToStart,
  NothingToSteer,
  NoticeNotTheUsersTurn,
  NotTheUsersTurn,
  OpenedByAnother,
  type Opener,
  SeveralChats,
  ThisChat
} from "./contract";

const LAST_CHARS = 16_000;

const LISTED = 50;

const NOTICE_CHARS = 4_000;

const MATCHES = 5;

type ChatsParts = {
  readonly chats: Pick<ChatList, "list" | "touch" | "rename" | "archive" | "wait" | "waitsFor" | "settle">;
  readonly openedFor: (request: string) => string | undefined;
  readonly openedBy: (session: string) => string | null;
  readonly open: (opener: Opener) => Promise<string>;
  readonly steer: (session: string, content: string, requestId: string) => Promise<void>;
  readonly busy: (session: string) => Promise<boolean>;
  readonly latest: (session: string) => string | null;
  readonly chat: (session: string) => boolean;
  /** Whether the turn running in `session` was started by the user's own message, not a report or another chat's. */
  readonly userStarted: (session: string) => boolean;
  /** Whether `session` took in the message submitted as `request`: the harness placed it in a run. */
  readonly taken: (session: string, request: string) => boolean;
};

const Args = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("steer"), Type.Literal("inspect")]),
  chat: Type.Optional(Type.String({ description: `A chat's id or its title as the user's list shows it; the main chat is ${ROOT_SESSION}, or "main".` })),
  message: Type.Optional(Type.String()),
  title: Type.Optional(Type.String({ description: "create: the chat's name in the user's list; named from the message when left out." })),
  notify: Type.Optional(
    Type.Boolean({ description: "create or steer: when that chat answers this message, its answer comes back here once, as a message that starts a turn. Only in a turn the user started." })
  )
});

/** The main chat has no row in the chat list; it reads as one, never archived and opened by nobody. */
const MAIN: ChatRow = { session: ROOT_SESSION, title: "main chat", created_at: 0, updated_at: 0, archived_at: null, opened_by: null, opened_request: null };

const shown = (row: ChatRow) => row.title || "untitled";

/** Every chat in the user's list, the main chat first, then the side chats newest first. */
const everyChat = (parts: ChatsParts): readonly ChatRow[] => [MAIN, ...parts.chats.list()];

const find = (parts: ChatsParts, session: string | undefined) => everyChat(parts).find((row) => row.session === session);

const folded = (text: string) => text.trim().toLowerCase();

/**
 * The chat `chat` names: its id, else the one chat whose title is it (any case), else the one whose title holds it.
 * "main" and "main chat" name the main chat.
 */
function resolve(parts: ChatsParts, chat: string | undefined): ChatRow | NoSuchChat | SeveralChats {
  const byId = find(parts, chat);

  if (byId) return byId;
  const name = folded(chat ?? "");
  const rows = everyChat(parts);
  const exact = name === "main" ? [MAIN] : rows.filter((row) => folded(shown(row)) === name);
  const near = name === "" ? [] : exact.length > 0 ? exact : rows.filter((row) => folded(shown(row)).includes(name));

  if (near.length === 1 && near[0]) return near[0];

  if (near.length === 0) return new NoSuchChat({ chat: chat ?? "" });

  return new SeveralChats({ chat: chat ?? "", matches: near.slice(0, MATCHES).map((row) => `${row.session} "${shown(row)}"`) });
}

function senderName(parts: ChatsParts, from: string): string {
  const row = find(parts, from);

  return (row ? shown(row) : "a chat").replaceAll(/["\]\n]/g, " ");
}

const fromOpener = (name: string, message: string) => `[chat "${name}": it opened this chat for the user and steers it; answer here, where the user reads it] ${message}`;

const fromAnother = (name: string, message: string) => `[chat "${name}": the user asked it to send this here; answer here, where the user reads it] ${message}`;

const asked = (notify: boolean) => (notify ? " Its answer comes back here when it has one; end the turn." : "");

function cut(text: string, chars: number): string {
  const all = Array.from(text);

  return all.length > chars ? `${all.slice(0, chars).join("")}…[truncated; ${all.length} chars total]` : text;
}

const answeredHere = (name: string, answer: string) =>
  `[chat "${name}" answered what this chat sent it; the user asked to be told here. Tell the user what it means for them; send nothing on] ${answer}`;

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

  return reply(`"${shown(row)}" is ${state}. ky's latest message there:\n${cut(text, LAST_CHARS)}`);
}

type Send = { readonly from: string; readonly task: number; readonly message: string; readonly notify: boolean };

async function create(parts: ChatsParts, send: Send, title: string | undefined): Promise<ToolExecutionResult> {
  const request = `chat-create:${send.from}:${send.task}`;
  const session = parts.openedFor(request) ?? (await parts.open({ by: send.from, request }));

  if (title?.trim()) parts.chats.rename(session, title);
  parts.chats.touch(session, send.message);

  // The wait is stored before the message goes, so the chat cannot answer it unseen.
  if (send.notify) parts.chats.wait(request, session, send.from);
  await parts.steer(session, fromOpener(senderName(parts, send.from), send.message), request);

  return reply(`Opened chat ${session}; its agent answers there, where the user reads it.${asked(send.notify)}`);
}

/**
 * Give `row` a message. A chat it opened takes one any time. Any other chat takes one only in a turn the user
 * started: a turn another chat's message started can then send nowhere but its own chats, which send nothing,
 * so two chats never keep waking each other.
 */
async function steer(parts: ChatsParts, send: Send, row: ChatRow): Promise<ToolExecutionResult> {
  const { from, message } = send;
  const opener = row.opened_by === from;
  const request = `chat-steer:${from}:${send.task}`;

  if (row.session === from) return reply(new ThisChat().refusal, true);

  if (!opener && !parts.userStarted(from)) return reply(new NotTheUsersTurn({ title: shown(row) }).refusal, true);

  if (row.archived_at !== null) parts.chats.archive(row.session, false);

  if (row.session !== ROOT_SESSION) parts.chats.touch(row.session, message);
  const name = senderName(parts, from);

  // The wait is stored before the message goes, so the chat cannot answer it unseen.
  if (send.notify) parts.chats.wait(request, row.session, from);
  await parts.steer(row.session, opener ? fromOpener(name, message) : fromAnother(name, message), request);

  return reply(`Sent to "${shown(row)}"; its agent answers there, where the user reads it.${asked(send.notify)}`);
}

async function call(parts: ChatsParts, args: Static<typeof Args>, from: string, task: number): Promise<ToolExecutionResult> {
  if (!parts.chat(from)) return reply(new NotAChat().refusal, true);

  if (args.action === "inspect" && args.chat === undefined) return list(parts, from);
  const row = resolve(parts, args.chat);

  // Reading is safe from any chat; only a chat with the user, not one another chat opened, sends.
  if (args.action === "inspect") return "session" in row ? inspect(parts, row) : reply(row.refusal, true);

  if (parts.openedBy(from) !== null) return reply(new OpenedByAnother().refusal, true);
  const send = { from, task, message: args.message?.trim() ?? "", notify: args.notify === true };

  // An answer that comes back starts a turn that is not the user's, so it can ask for no answer of its own: one user
  // message brings back each answer it asked for once, and nothing more.
  if (send.notify && !parts.userStarted(from)) return reply(new NoticeNotTheUsersTurn().refusal, true);

  if (args.action === "create") return send.message === "" ? reply(new NothingToStart().refusal, true) : create(parts, send, args.title);

  if (!("session" in row)) return reply(row.refusal, true);

  return send.message === "" ? reply(new NothingToSteer().refusal, true) : steer(parts, send, row);
}

/**
 * When a chat answers, each chat that asked to be told about a message it took in gets the answer, once. The notice's
 * request id comes from the send's, so a hook rerun after a crash submits nothing new; the wait goes once it is sent.
 * A message still queued is not answered yet: its wait stays for the answer after it.
 */
async function tellWaiting(parts: ChatsParts, target: string, answer: string): Promise<void> {
  for (const wait of parts.chats.waitsFor(target)) {
    if (!parts.taken(target, wait.request)) continue;
    await parts.steer(wait.sender, answeredHere(senderName(parts, target), cut(answer, NOTICE_CHARS) || "(no text)"), `chat-notice:${wait.request}`);
    parts.chats.settle(wait.request);
  }
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
          "create (message, title?, notify?): open a side chat and give its agent the message, which it starts on there; say what to do, as to a colleague. " +
          "steer (chat, message, notify?): send a chat a message: it joins the turn it is in, or starts one. A chat this one opened takes one any time; any other chat only when the user asked in this turn. " +
          "chat takes a chat's id or its title. Answers stay in that chat; with notify, the answer also comes back here once, and you end the turn until it does. Without notify, inspect later when the user asks.",
        parameters: Args,
        replay: "safe",
        execute: (args, api) => call(parts, args, String(api.conversationId), api.taskId)
      })
    ],
    hooks: [
      hook(GenerationTask, {
        async onYield(answer, api) {
          await tellWaiting(parts, String(api.conversationId), textOf(answer).trim());

          return undefined;
        }
      })
    ]
  });
}
