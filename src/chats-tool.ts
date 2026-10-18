import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import type { Delivery } from "./automations/contract";
import type { ChatList, ChatRow } from "./chats";

/**
 * chats: a chat's agent sees the user's other chats, the main one and the side chats not archived, and works
 * with them: it hands one a message, which that chat's agent answers there, between its turns, as a delivery
 * (src/automations/delivery.ts); or it reads what ky last said in one.
 */

/** ky's last message as `last` shows it, at most. */
const LAST_CHARS = 16_000;

const reply = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });

/** What the tool needs from the rest of ky, set up in src/server.ts. */
type ChatsParts = {
  readonly chats: Pick<ChatList, "list" | "mainUpdatedAt">;
  /** ky's latest message with text in a chat; null before the first (History.latest). */
  readonly latest: (session: string) => string | null;
  readonly deliver: (item: Delivery) => Promise<void>;
  /** The main chat or a side chat, as against a subagent or a seat. */
  readonly chat: (session: string) => boolean;
};

type Listed = { readonly session: string; readonly name: string; readonly title: string; readonly updated: number };

type Reply = ReturnType<typeof reply>;

const titleOf = (row: ChatRow) => row.title || "untitled";

/** The chats not archived, the main one first: its name in the tool (`main` or its session) and its title. */
function listed(chats: ChatsParts["chats"]): Listed[] {
  const sides = chats.list().flatMap((row) => (row.archived_at === null ? [{ session: row.session, name: row.session, title: titleOf(row), updated: row.updated_at }] : []));

  return [{ session: ROOT_SESSION, name: "main", title: "main", updated: chats.mainUpdatedAt() }, ...sides];
}

function list(chats: readonly Listed[]): Reply {
  return reply(chats.map((each) => `${each.name} "${each.title}", updated ${each.updated === 0 ? "never" : new Date(each.updated).toISOString()}`).join("\n"));
}

function last(parts: ChatsParts, to: Listed): Reply {
  const text = parts.latest(to.session);

  if (text === null) return reply(`No message from ky yet in ${to.title}.`);

  return reply(text.length > LAST_CHARS ? `${text.slice(0, LAST_CHARS)}…[truncated; ${text.length} chars total]` : text);
}

/** Hand `to` the message as a delivery whose id is the call's, so however often the call runs it goes in once. */
async function send(parts: ChatsParts, to: Listed, from: string, callId: string, text = ""): Promise<Reply> {
  const message = text.trim();

  if (to.session === from) return reply("That is this chat: answer here instead.", true);

  if (message === "") return reply("Nothing to send: give a message.", true);
  // The sender may be an archived chat the user still writes in, so it is named from the whole list.
  const row = parts.chats.list().find((each) => each.session === from);
  const sender = row ? titleOf(row) : "main";

  await parts.deliver({
    id: `chat:${from}:${callId}`,
    session: to.session,
    content: `[message from your ${sender} chat: answer here; it is not shown there] ${message}`,
    line: `From your ${sender} chat: ${message}`,
    ref: `chat:${from}`
  });

  return reply(`Sent to ${to.title}; its agent answers there.`);
}

/** Only a chat with the user has other chats to work with; elsewhere the call is refused. */
export function chatsExtension(parts: ChatsParts): Extension {
  return defineExtension({
    name: "chats",
    tools: [
      defineTool({
        name: "chats",
        description:
          "The user's other chats: the main chat and the side chats. Actions: list: each chat (main, or its id), its title and when it was last updated. " +
          "send (chat, message): hand that chat's agent a message; it answers there, not here, and its answer is not shown to you. " +
          "last (chat): ky's latest message in that chat. chat is main or a side chat's id from list.",
        parameters: Type.Object({
          action: Type.Union([Type.Literal("list"), Type.Literal("send"), Type.Literal("last")]),
          chat: Type.Optional(Type.String()),
          message: Type.Optional(Type.String())
        }),
        // send's delivery id is the call's, so a replay delivers nothing more.
        replay: "safe",
        execute: async (args, api) => {
          const from = String(api.conversationId);

          if (!parts.chat(from)) return reply("Only a chat with the user has other chats.", true);
          const chats = listed(parts.chats);

          if (args.action === "list") return list(chats);
          const to = chats.find((each) => each.name === args.chat);

          if (!to) return reply(`No chat ${JSON.stringify(args.chat ?? "")}: use main or an id from list.`, true);

          return args.action === "last" ? last(parts, to) : send(parts, to, from, api.callId, args.message);
        }
      })
    ]
  });
}
