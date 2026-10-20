import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import type { Delivery } from "./automations/contract";
import type { ChatList, ChatRow } from "./chats";
import { isOwnRequest } from "./history";

/**
 * chats: a chat's agent sees the user's other chats, the main one and the side chats, archived ones marked, and works
 * with them: it hands one a message, which that chat's agent answers there, between its turns, as a delivery
 * (src/automations/delivery.ts); it asks one, whose agent answers there and has its answer handed back the same way;
 * or it reads what ky last said in one. Sending or asking puts an archived chat back in the list.
 */

/** ky's last message as `last` shows it, at most. */
const LAST_CHARS = 16_000;

/** What a sent message's delivery id starts with: the request id its turn in the other chat runs for. */
const SENT = "chat:";

/** What a question's delivery id starts with, then `<asking chat>:<task>`: the turn answering it hands its answer back. */
const ASKED = `${SENT}ask:`;

/** What an answer handed back has for its id, then the question's `<asking chat>:<task>`. */
const ANSWERED = `${SENT}answer:`;

const reply = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });

/** What the tool needs from the rest of ky, set up in src/server.ts. */
type ChatsParts = {
  readonly chats: Pick<ChatList, "list" | "mainUpdatedAt" | "archive">;
  /** ky's latest message with text in a chat; null before the first (History.latest). */
  readonly latest: (session: string) => string | null;
  readonly deliver: (item: Delivery) => Promise<void>;
  /** The request ids that placed the user entries of the chat's running turn, oldest first (src/history.ts turnPlacedBy). */
  readonly turn: (session: string) => ReadonlyArray<string | undefined>;
  /** The main chat or a side chat, as against a subagent or a seat. */
  readonly chat: (session: string) => boolean;
};

type Listed = { readonly session: string; readonly name: string; readonly title: string; readonly updated: number; readonly archived: boolean };

type Reply = ReturnType<typeof reply>;

const titleOf = (row: ChatRow) => row.title || "untitled";

/** Every chat, the main one first, then the side chats, archived ones after: its name in the tool (`main` or its session) and its title. */
function listed(chats: ChatsParts["chats"]): Listed[] {
  const sides = chats.list().map((row) => ({ session: row.session, name: row.session, title: titleOf(row), updated: row.updated_at, archived: row.archived_at !== null }));

  return [{ session: ROOT_SESSION, name: "main", title: "main", updated: chats.mainUpdatedAt(), archived: false }, ...sides.filter((each) => !each.archived), ...sides.filter((each) => each.archived)];
}

function list(chats: readonly Listed[]): Reply {
  return reply(
    chats.map((each) => `${each.name} "${each.title}", updated ${each.updated === 0 ? "never" : new Date(each.updated).toISOString()}${each.archived ? ", archived" : ""}`).join("\n")
  );
}

function last(parts: ChatsParts, to: Listed): Reply {
  const text = parts.latest(to.session);

  if (text === null) return reply(`No message from ky yet in ${to.title}.`);
  // By code point, so the cut never splits a surrogate pair.
  const chars = Array.from(text);

  return reply(chars.length > LAST_CHARS ? `${chars.slice(0, LAST_CHARS).join("")}…[truncated; ${chars.length} chars total]` : text);
}

/**
 * Whether the running turn answers another chat's message: one is in it, and the user has not written since.
 * A report from a background subagent that starts a turn of its own after that one is over is not caught.
 */
function answersChat(turn: ReadonlyArray<string | undefined>): boolean {
  const sent = turn.findLastIndex((request) => request?.startsWith(SENT) === true);

  return sent !== -1 && !turn.slice(sent + 1).some(isOwnRequest);
}

/** The chat `from` as another chat's agent is told of it: titles repeat, so a side chat by its id too. */
function senderOf(parts: ChatsParts, from: string): string {
  // The sender may be an archived chat the user still writes in, so it is named from the whole list.
  const row = parts.chats.list().find((each) => each.session === from);

  return row ? `chat ${from} "${titleOf(row)}"` : "main chat";
}

/**
 * Hand `to` the message as a chat delivery, keyed by the tool call's task, so however often the call runs it goes
 * in once; a question's id says where its answer goes back. A turn that answers another chat's message, or takes
 * an answer back, sends nothing on, so two chats never talk in a loop. An archived chat is put back in the list,
 * so the user sees where it went.
 */
async function send(parts: ChatsParts, to: Listed, from: string, task: number, asking: boolean, text = ""): Promise<Reply> {
  const message = text.trim();

  if (answersChat(parts.turn(from))) return reply("This turn answers another chat's message: answer here.", true);

  if (to.session === from) return reply("That is this chat: answer here instead.", true);

  if (message === "") return reply(`Nothing to ${asking ? "ask" : "send"}: give a message.`, true);
  const sender = senderOf(parts, from);

  if (to.archived) parts.chats.archive(to.session, false);

  await parts.deliver({
    id: `${asking ? ASKED : SENT}${from}:${task}`,
    session: to.session,
    content: asking
      ? `[question from your ${sender}: answer here; your answer goes back to it] ${message}`
      : `[message from your ${sender}: answer here; it is not shown there] ${message}`,
    line: `From your ${sender}: ${message}`,
    ref: `chat:${from}`,
    kind: "chat"
  });

  return asking
    ? reply(`Asked ${to.title}; its agent answers there, and its answer comes back to you here as a message once it is done.`)
    : reply(`Sent to ${to.title}; its agent answers there.`);
}

/** The text of an answer: its text parts, joined. */
const textOf = (answer: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }) =>
  answer.content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("").trim();

/**
 * A chat's turn has its final answer: each question from another chat that placed it gets that answer handed back,
 * keyed by the question, so a recovered turn yields it again for nothing. A turn the user stops, or that fails,
 * has no final answer and hands nothing back; the asking chat can still read it with last.
 */
async function answerBack(parts: ChatsParts, session: string, text: string): Promise<void> {
  const questions = parts.turn(session).flatMap((request) => (request?.startsWith(ASKED) === true ? [request.slice(ASKED.length)] : []));

  if (questions.length === 0) return;
  const sender = senderOf(parts, session);
  const answer = text === "" ? "(it answered with no text)" : text;

  for (const question of questions) {
    await parts.deliver({
      id: `${ANSWERED}${question}`,
      session: question.slice(0, question.lastIndexOf(":")),
      content: `[answer from your ${sender} to what you asked it; tell the user what matters] ${answer}`,
      line: `Answer from your ${sender}: ${answer}`,
      ref: `chat:${session}`,
      kind: "chat"
    });
  }
}

/** Only a chat with the user has other chats to work with; elsewhere the call is refused. A chat's final answer goes back to each chat that asked for it. */
export function chatsExtension(parts: ChatsParts): Extension {
  return defineExtension({
    name: "chats",
    tools: [
      defineTool({
        name: "chats",
        description:
          "The user's other chats: the main chat and the side chats. Actions: list: each chat (main, or its id), its title and when it was last updated. " +
          "send (chat, message): hand that chat's agent a message; it answers there, not here, and its answer is not shown to you. " +
          "ask (chat, message): hand that chat's agent a question; it answers there, and its answer comes back to you as a message after this turn, so end the turn rather than wait. " +
          "last (chat): ky's latest message in that chat. chat is main or a side chat's id from list; an archived one comes back to the user's list when you send or ask.",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("list"), Type.Literal("send"), Type.Literal("ask"), Type.Literal("last")]),
          chat: Type.Optional(Type.String()),
          message: Type.Optional(Type.String())
        }),
        // send's and ask's delivery id is the call's task, so a replay delivers nothing more.
        replay: "safe",
        execute: async (args, api) => {
          const from = String(api.conversationId);

          if (!parts.chat(from)) return reply("Only a chat with the user has other chats.", true);
          const chats = listed(parts.chats);

          if (args.action === "list") return list(chats);
          const to = chats.find((each) => each.name === args.chat);

          if (!to) return reply(`No chat ${JSON.stringify(args.chat ?? "")}: use main or an id from list.`, true);

          return args.action === "last" ? last(parts, to) : send(parts, to, from, api.taskId, args.action === "ask", args.message);
        }
      })
    ],
    hooks: [
      hook(GenerationTask, {
        async onYield(answer, api) {
          const session = String(api.conversationId);

          if (parts.chat(session)) await answerBack(parts, session, textOf(answer));

          return undefined;
        }
      })
    ]
  });
}
