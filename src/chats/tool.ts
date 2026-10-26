import { type Static, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEdge } from "../core/edge";
import { isRefusal } from "../core/refusal";
import { toolReply as reply } from "../core/reply";
import type { ChatList } from "./chats";
import { type ChatRow, NotAChat, NothingToStart, NothingToSteer, NotOpenedHere, OpenedByAnother, type Opener } from "./contract";

const LAST_CHARS = 16_000;

type ChatsParts = {
  readonly chats: Pick<ChatList, "list" | "touch" | "rename" | "archive">;
  readonly openedFor: (request: string) => string | undefined;
  readonly openedBy: (session: string) => string | null;
  readonly open: (opener: Opener) => Promise<string>;
  readonly steer: (session: string, content: string, requestId: string) => Promise<void>;
  readonly busy: (session: string) => Promise<boolean>;
  readonly latest: (session: string) => string | null;
  readonly chat: (session: string) => boolean;
};

const Args = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("steer"), Type.Literal("inspect")]),
  chat: Type.Optional(Type.String({ description: "A chat's id, from create or inspect." })),
  message: Type.Optional(Type.String()),
  title: Type.Optional(Type.String({ description: "create: the chat's name in the user's list; named from the message when left out." }))
});

const shown = (row: ChatRow) => row.title || "untitled";

function openerName(parts: ChatsParts, from: string): string {
  if (from === ROOT_SESSION) return "main chat";
  const row = parts.chats.list().find((each) => each.session === from);

  return (row ? shown(row) : "a chat").replaceAll(/["\]\n]/g, " ");
}

const fromOpener = (name: string, message: string) => `[chat "${name}": it opened this chat for the user and steers it; answer here, where the user reads it] ${message}`;

const ownedBy = (parts: ChatsParts, from: string) => parts.chats.list().filter((row) => row.opened_by === from);

async function list(parts: ChatsParts, from: string): Promise<ToolExecutionResult> {
  const rows = ownedBy(parts, from);

  if (rows.length === 0) return reply("This chat has opened no chats yet.");

  const lines = await Promise.all(
    rows.map(async (row) => `${row.session} "${shown(row)}", ${(await parts.busy(row.session)) ? "working" : "idle"}, updated ${new Date(row.updated_at).toISOString()}${row.archived_at === null ? "" : ", archived"}`)
  );

  return reply(lines.join("\n"));
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
  await parts.steer(session, fromOpener(openerName(parts, from), message), request);

  return reply(`Opened chat ${session}; its agent answers there, where the user reads it. Use inspect to see how it is going.`);
}

async function steer(parts: ChatsParts, from: string, task: number, row: ChatRow, message: string): Promise<ToolExecutionResult> {
  if (row.archived_at !== null) parts.chats.archive(row.session, false);
  parts.chats.touch(row.session, message);
  await parts.steer(row.session, fromOpener(openerName(parts, from), message), `chat-steer:${from}:${task}`);

  return reply(`Steered "${shown(row)}"; its agent answers there.`);
}

const call = (parts: ChatsParts, args: Static<typeof Args>, from: string, task: number) =>
  Effect.gen(function* () {
    if (!parts.chat(from)) return yield* new NotAChat();

    if (parts.openedBy(from) !== null) return yield* new OpenedByAnother();

    if (args.action === "inspect" && args.chat === undefined) return yield* Effect.promise(() => list(parts, from));
    const message = args.message?.trim() ?? "";

    if (args.action === "create") return message === "" ? yield* new NothingToStart() : yield* Effect.promise(() => create(parts, from, task, message, args.title));
    const row = ownedBy(parts, from).find((each) => each.session === args.chat);

    if (!row) return yield* new NotOpenedHere({ chat: args.chat ?? "" });

    if (args.action === "inspect") return yield* Effect.promise(() => inspect(parts, row));

    return message === "" ? yield* new NothingToSteer() : yield* Effect.promise(() => steer(parts, from, task, row, message));
  });

export function chatsExtension(parts: ChatsParts): Extension {
  const edge = makeEdge(Layer.empty);

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
        parameters: Args,
        replay: "safe",
        execute: async (args, api) => {
          const result = await edge.runPromise(call(parts, args, String(api.conversationId), api.taskId));

          return isRefusal(result) ? reply(result.refused, true) : result;
        }
      })
    ]
  });
}
