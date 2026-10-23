import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import type { ChatList, ChatRow, Opener } from "./chats";

/**
 * chats: a chat with the user opens side chats and runs them, as scotty's sessions are run. It creates one with a
 * first message, which that chat's agent answers there, where the user reads it; steers one it opened with another
 * message, which joins the turn it is in or starts one; and inspects them: whether each is working, and what ky last
 * said in one. Control runs one way: a chat this opened has no chats tool, and nothing it says comes back on its
 * own, so the opener pulls with inspect. Every message one chat gives another starts at the opener's tool call, so
 * no two chats can wake each other in a loop. A message from a chat is ky's, not the user's: its request id is named
 * (`chat-create:` or `chat-steer:`, then `<opener>:<task>`), and the thread shows it as a quiet line from that chat.
 */

/** ky's last message as inspect shows it, at most. */
const LAST_CHARS = 16_000;

const reply = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });

type Reply = ReturnType<typeof reply>;

/** What the tool needs from the rest of ky, set up in src/server.ts. */
type ChatsParts = {
  readonly chats: Pick<ChatList, "list" | "touch" | "rename" | "archive">;
  /** The chat a create opened by `request`, if one did (ChatList.openedFor). */
  readonly openedFor: (request: string) => string | undefined;
  /** The chat that opened `session`; null for the main chat and the user's own (ChatList.openedBy). */
  readonly openedBy: (session: string) => string | null;
  /** A new side chat, set up as the user's are, in the list as `opener`'s (Ky.newChat). */
  readonly open: (opener: Opener) => Promise<string>;
  /** Give the chat's agent `content` by `requestId`, steering its running turn or starting one; pi takes a request id once. */
  readonly steer: (session: string, content: string, requestId: string) => Promise<void>;
  /** Whether the chat has a run going. */
  readonly busy: (session: string) => Promise<boolean>;
  /** ky's latest message with text in a chat; null before the first (History.latest). */
  readonly latest: (session: string) => string | null;
  /** The main chat or a side chat, as against a subagent or a seat. */
  readonly chat: (session: string) => boolean;
};

const titleOf = (row: ChatRow) => row.title || "untitled";

/** The opener as the chats it runs are told of it, and the thread's quiet line names it: no quote or bracket, which would end the line's header. */
function openerName(parts: ChatsParts, from: string): string {
  if (from === ROOT_SESSION) return "main chat";
  const row = parts.chats.list().find((each) => each.session === from);

  return (row ? titleOf(row) : "a chat").replaceAll(/["\]\n]/g, " ");
}

/** What a chat's agent is given: a header the thread reads as a quiet line from the opener (src/ui/turns.ts REPORT), then the message. */
const fromOpener = (name: string, message: string) => `[chat "${name}": it opened this chat for the user and steers it; answer here, where the user reads it] ${message}`;

/** The chats `from` opened, in the list or archived. */
const ownedBy = (parts: ChatsParts, from: string) => parts.chats.list().filter((row) => row.opened_by === from);

async function list(parts: ChatsParts, from: string): Promise<Reply> {
  const rows = ownedBy(parts, from);

  if (rows.length === 0) return reply("This chat has opened no chats yet.");

  const lines = await Promise.all(
    rows.map(async (row) => `${row.session} "${titleOf(row)}", ${(await parts.busy(row.session)) ? "working" : "idle"}, updated ${new Date(row.updated_at).toISOString()}${row.archived_at === null ? "" : ", archived"}`)
  );

  return reply(lines.join("\n"));
}

async function inspect(parts: ChatsParts, row: ChatRow): Promise<Reply> {
  const state = (await parts.busy(row.session)) ? "working" : "idle";
  const text = parts.latest(row.session);

  if (text === null) return reply(`"${titleOf(row)}" is ${state}; no message from ky in it yet.`);
  // By code point, so the cut never splits a surrogate pair.
  const chars = Array.from(text);
  const said = chars.length > LAST_CHARS ? `${chars.slice(0, LAST_CHARS).join("")}…[truncated; ${chars.length} chars total]` : text;

  return reply(`"${titleOf(row)}" is ${state}. ky's latest message there:\n${said}`);
}

/**
 * Open a chat for `from` keyed by the call's task, so however often the call runs there is one chat and one first
 * message: a run again finds the chat by its request, and pi takes the request once. A crash after pi made the
 * conversation and before the list has it leaves a conversation nothing shows, and the run again opens another.
 */
async function create(parts: ChatsParts, from: string, task: number, message: string, title: string | undefined): Promise<Reply> {
  const request = `chat-create:${from}:${task}`;
  const session = parts.openedFor(request) ?? (await parts.open({ by: from, request }));

  if (title?.trim()) parts.chats.rename(session, title);
  // Named from the message when no title was given, as the user's first message names a chat.
  parts.chats.touch(session, message);
  await parts.steer(session, fromOpener(openerName(parts, from), message), request);

  return reply(`Opened chat ${session}; its agent answers there, where the user reads it. Use inspect to see how it is going.`);
}

/** Steer `row` with the message, keyed by the call's task, so a call run again gives it once. An archived chat comes back to the user's list. */
async function steer(parts: ChatsParts, from: string, task: number, row: ChatRow, message: string): Promise<Reply> {
  if (row.archived_at !== null) parts.chats.archive(row.session, false);
  parts.chats.touch(row.session, message);
  await parts.steer(row.session, fromOpener(openerName(parts, from), message), `chat-steer:${from}:${task}`);

  return reply(`Steered "${titleOf(row)}"; its agent answers there.`);
}

/** Only a chat with the user that no chat opened runs other chats; elsewhere the call is refused. */
export function chatsExtension(parts: ChatsParts): Extension {
  return defineExtension({
    name: "chats",
    tools: [
      defineTool({
        name: "chats",
        description:
          "Open side chats for the user and run them; each is a full ky chat the user sees in their list. " +
          "create (message, title?): open a side chat and give its agent the message, which it starts on there; say what to do, as to a colleague. " +
          "steer (chat, message): give a chat this one opened another message: it joins the turn it is in, or starts one. " +
          "inspect (chat?): with no chat, the chats this one opened, each working or idle; with a chat, whether it is working and ky's latest message there. " +
          "Their answers stay there and do not come back to you: end the turn, and inspect later when the user asks.",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("create"), Type.Literal("steer"), Type.Literal("inspect")]),
          chat: Type.Optional(Type.String({ description: "A chat's id, from create or inspect." })),
          message: Type.Optional(Type.String()),
          title: Type.Optional(Type.String({ description: "create: the chat's name in the user's list; named from the message when left out." }))
        }),
        // create and steer go in by a request id from the call's task, so a replay opens and gives nothing more.
        replay: "safe",
        execute: async (args, api) => {
          const from = String(api.conversationId);

          if (!parts.chat(from)) return reply("Only a chat with the user runs other chats.", true);

          if (parts.openedBy(from) !== null) return reply("Another chat opened this one, so this one runs none: answer here.", true);

          if (args.action === "inspect" && args.chat === undefined) return list(parts, from);
          const message = args.message?.trim() ?? "";

          if (args.action === "create") return message === "" ? reply("Nothing to start it on: give a message.", true) : create(parts, from, api.taskId, message, args.title);
          const row = ownedBy(parts, from).find((each) => each.session === args.chat);

          if (!row) return reply(`No chat ${JSON.stringify(args.chat ?? "")} that this chat opened: inspect lists them.`, true);

          if (args.action === "inspect") return inspect(parts, row);

          return message === "" ? reply("Nothing to steer it with: give a message.", true) : steer(parts, from, api.taskId, row, message);
        }
      })
    ]
  });
}
