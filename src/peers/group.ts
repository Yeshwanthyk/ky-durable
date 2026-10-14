import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  configure,
  defineExtension,
  defineTask,
  type EntryDraft,
  type Extension,
  type Tx,
  type UserInput
} from "@earendil-works/pi-durable";
import { agentModel } from "../models";
import type { ModelChoice } from "../settings";
import { mentions, setUp, type SpecialistRow, type Specialists, textOf } from "../skills/specialists";
import { summarize, type TaskFeed } from "../automations/tasks";
import {
  FOR_MARK,
  type PiMessage,
  projectEntries,
  SPECIALIST_REPLY,
  type SpecialistReplyData,
  TO_SPECIALISTS,
  type ToSpecialistsData
} from "../transcript";

/**
 * Specialists in chat: the user @-mentions one, or a group chat's members
 * take up a message on their own, and each posts its own reply in the chat.
 * docs/group-chat-routing.md has the research and the rules; in short:
 *
 * - Only a user's message, as the socket submits it, is ever routed. The
 *   user's message and every reply are passive entries in the chat: they
 *   start no run of ky's, and nothing reads them to route again.
 * - At most RESPONDER_CAP specialists answer one message, @'d or routed.
 * - Each answers in its seat for the chat, a conversation of its own that
 *   cannot ask or start other agents, from the same snapshot of the chat:
 *   in parallel, without seeing the others' replies. Each has REPLY_TIMEOUT_MS.
 * - A message is decided once, by its operation id: a resend gets the same
 *   responders, and every write after it carries a request id, so it posts once.
 */

/** Specialists that answer one user message, at most. */
export const RESPONDER_CAP = 3;

/** How long a specialist has for one reply before its seat is stopped. */
/** Each group chat's member ids, by session. */
export type GroupMembers = Record<string, string[]>;

const REPLY_TIMEOUT_MS = 4 * 60_000;

/** The chat a specialist and the router see: this many recent messages, each and all cut. */
const RECENT_MESSAGES = 8;

const RECENT_LINE_CHARS = 600;

const RECENT_CHARS = 3_000;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** Who answers a user's message, as decided once. */
export type RoutePlan = { readonly to: readonly string[] } | { readonly refused: string };

/**
 * Who answers a user's message: the specialists it starts by @-ing, else
 * the members of a group chat `pick` chooses, else ky (an empty list).
 */
export async function plan(
  text: string,
  members: readonly SpecialistRow[],
  pick: (members: readonly SpecialistRow[]) => Promise<readonly string[]>
): Promise<RoutePlan> {
  const mentioned = [...new Set(mentions(text))];

  if (mentioned.length > RESPONDER_CAP) return { refused: `At most ${RESPONDER_CAP} specialists can answer one message.` };

  if (mentioned.length > 0) return { to: mentioned };

  if (members.length === 0) return { to: [] };

  return { to: parseRoute((await pick(members)).join(", "), members) };
}

export const ROUTER_PROMPT = `You pick which specialists in a group chat answer the user's latest message. Each specialist has an id and a description of its line of work. Pick only those whose line the message is clearly in; most messages need one or none. Pick none for small talk, thanks, or anything for ky, the user's general assistant, who answers whatever no specialist takes. Pick at most ${RESPONDER_CAP}. Reply with the ids alone, comma-separated, like: engineer, designer. Or reply: none.`;

/** What the router reads: the members, the recent chat, and the message. */
export function routerInput(members: readonly SpecialistRow[], recent: string, text: string): string {
  const roster = members.map((each) => `- ${each.id}: ${each.description}`).join("\n");

  return `Specialists:\n${roster}\n\n${recent ? `Recent chat:\n${recent}\n\n` : ""}Message:\n${text}`;
}

/** The members a router's answer names, in its order, once each, at most RESPONDER_CAP. */
export function parseRoute(answer: string, members: readonly SpecialistRow[]): string[] {
  const known = new Set(members.map((each) => each.id));
  const picked: string[] = [];

  for (const [, id] of answer.toLowerCase().matchAll(/@?([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    if (id !== undefined && known.has(id) && !picked.includes(id)) picked.push(id);
  }

  return picked.slice(0, RESPONDER_CAP);
}

/** The router's pick; none when it fails, so ky answers. */
async function route(
  complete: (system: string, text: string) => Promise<string>,
  members: readonly SpecialistRow[],
  recent: string,
  text: string
): Promise<string[]> {
  try {
    return parseRoute(await complete(ROUTER_PROMPT, routerInput(members, recent, text)), members);
  } catch (error) {
    console.warn("ky group routing failed", error);

    return [];
  }
}

const words = (message: PiMessage) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();

/** The chat's last few messages, oldest first, as `who: text` lines: the user, ky's answers, and specialists' replies. */
export function recentOf(messages: readonly PiMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    const text = flat(words(message).replace(FOR_MARK, ""));

    if (text === "") continue;

    if (message.role === "user" && !text.startsWith("[")) lines.push(`user: ${cut(text, RECENT_LINE_CHARS)}`);
    else if (message.role === "specialist" && message.error === undefined) lines.push(`@${message.from}: ${cut(text, RECENT_LINE_CHARS)}`);
    else if (message.role === "assistant" && message.stopReason !== "toolUse") lines.push(`ky: ${cut(text, RECENT_LINE_CHARS)}`);
  }

  let recent = lines.slice(-RECENT_MESSAGES);

  while (recent.length > 1 && recent.join("\n").length > RECENT_CHARS) recent = recent.slice(1);

  return cut(recent.join("\n"), RECENT_CHARS);
}

/** What a specialist reads in its seat: the recent chat and the user's message. */
function seatPrompt(recent: string, text: string): string {
  return `[a message in the user's chat]${recent ? ` Recent messages there, for context:\n<chat>\n${recent}\n</chat>\n` : "\n"}\nThe user's message:\n${text}`;
}

/** The user's message as ky reads it: marked for the specialists, so ky does not answer it. */
export function forThem(input: UserInput, to: readonly string[]): UserInput {
  const mark = `[for ${to.map((id) => `@${id}`).join(", ")}] `;

  if (!Array.isArray(input)) return `${mark}${String(input)}`;

  return [{ type: "text", text: mark }, ...input];
}

/** Chats' members, specialists' seats in chats, and the decision on each message, by its operation id. */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS ky_chat_members (
    chat TEXT NOT NULL,
    specialist TEXT NOT NULL,
    PRIMARY KEY (chat, specialist))`,
  `CREATE TABLE IF NOT EXISTS ky_specialist_seats (
    chat TEXT NOT NULL,
    specialist TEXT NOT NULL,
    session TEXT NOT NULL,
    PRIMARY KEY (chat, specialist))`,
  `CREATE TABLE IF NOT EXISTS ky_group_messages (
    chat TEXT NOT NULL,
    request TEXT NOT NULL,
    responders TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat, request))`
];

export class GroupChats {
  readonly #sql: SqlStorage;
  readonly #specialists: Specialists;
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage, specialists: Specialists) {
    this.#sql = sql;
    this.#specialists = specialists;

    for (const table of TABLES) sql.exec(table);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  /** A chat's members that are still specialists, by id. */
  members(chat: string): SpecialistRow[] {
    return this.#sql
      .exec<{ specialist: string }>("SELECT specialist FROM ky_chat_members WHERE chat = ? ORDER BY specialist", chat)
      .toArray()
      .flatMap(({ specialist }) => this.#specialists.get(specialist) ?? []);
  }

  /** Every group chat's member ids; a chat with none is not in it. */
  all(): GroupMembers {
    const groups = new Map<string, string[]>();

    for (const { chat, specialist } of this.#sql
      .exec<{ chat: string; specialist: string }>("SELECT chat, specialist FROM ky_chat_members ORDER BY specialist")
      .toArray()) {
      if (!this.#specialists.has(specialist)) continue;

      const members = groups.get(chat) ?? [];
      members.push(specialist);
      groups.set(chat, members);
    }

    return Object.fromEntries(groups);
  }

  /** Make `ids` the chat's members; none makes it a plain chat again. */
  setMembers(chat: string, ids: readonly string[]): void {
    const missing = ids.find((id) => !this.#specialists.has(id));

    if (missing !== undefined) throw new Error(`No specialist @${missing}.`);
    this.#sql.exec("DELETE FROM ky_chat_members WHERE chat = ?", chat);

    for (const id of new Set(ids)) this.#sql.exec("INSERT INTO ky_chat_members (chat, specialist) VALUES (?, ?)", chat, id);
    this.#emit();
  }

  /** The specialist's seat in the chat, made on its first reply there. */
  seat(chat: string, id: string): string | undefined {
    return this.#sql
      .exec<{ session: string }>("SELECT session FROM ky_specialist_seats WHERE chat = ? AND specialist = ?", chat, id)
      .toArray()[0]?.session;
  }

  sit(chat: string, id: string, session: string): void {
    this.#sql.exec("INSERT OR REPLACE INTO ky_specialist_seats (chat, specialist, session) VALUES (?, ?, ?)", chat, id, session);
  }

  /** Who a message was decided for, if it was. */
  decided(chat: string, request: string): string[] | undefined {
    const row = this.#sql
      .exec<{ responders: string }>("SELECT responders FROM ky_group_messages WHERE chat = ? AND request = ?", chat, request)
      .toArray()[0];

    // SAFETY: only decide() writes responders, a JSON array of ids.
    return row && (JSON.parse(row.responders) as string[]);
  }

  /** Record who answers a message; the first decision stands, and is returned. */
  decide(chat: string, request: string, responders: readonly string[]): string[] {
    this.#sql.exec(
      "INSERT OR IGNORE INTO ky_group_messages (chat, request, responders, created_at) VALUES (?, ?, ?, ?)",
      chat,
      request,
      JSON.stringify(responders),
      Date.now()
    );

    return this.decided(chat, request)!;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

type ReplyInput = {
  readonly specialist: string;
  readonly seat: ConversationId;
  /** What the specialist reads, as JSON. */
  readonly content: JsonValue;
  /** The user message's operation id. */
  readonly request: string;
  readonly feedId: string;
};

type ReplyState = { phase: "answer" } | { phase: "post"; text: string; failed: boolean };

/** What a group desk needs from ky. */
export type GroupDeps = {
  readonly store: GroupChats;
  readonly specialists: Specialists;
  readonly feed: TaskFeed;
  /** A chat's conversation. */
  readonly conversation: (session: string) => Promise<Conversation>;
  /** One short answer from the background model, for routing. */
  readonly complete: (system: string, text: string) => Promise<string>;
  /** A specialist replied in the chat. */
  readonly answered: (session: string) => void;
  readonly context: Context;
};

/** How a specialist's seat is set up: what it does without, and its model. */
export type SeatDeps = {
  readonly remove: readonly Extension[];
  readonly model: (own: ModelChoice | null) => ModelChoice;
};

const background = (conversationId: ConversationId) =>
  ({ ownership: { kind: "conversation" }, conversationId, background: true }) as const;

const terminal = { status: "terminal", outcome: { status: "completed", result: null } } as const;

/**
 * Routes the user's messages in chats to specialists, and posts their replies.
 * Made with ky; its task is defined once pi opens, in `extension()`.
 */
export class GroupDesk {
  readonly #deps: GroupDeps;
  #seats: SeatDeps | undefined;
  #reply: ReturnType<typeof defineTask<ReplyInput, ReplyState, null>> | undefined;

  constructor(deps: GroupDeps) {
    this.#deps = deps;
  }

  /** The reply task, for pi's registry. */
  extension(seats: SeatDeps) {
    this.#seats = seats;
    const { feed } = this.#deps;

    /** A specialist's post in the chat: a passive entry, so it starts no run and is never routed. */
    const post = async (chat: string, input: ReplyInput, text: string, failed: boolean) => {
      const data: SpecialistReplyData = { specialist: input.specialist, text, failed };

      const entry: EntryDraft = {
        kind: SPECIALIST_REPLY,
        data,
        // ky reads it, so it knows what was said, but does not answer it.
        model: [{ role: "user", content: `[@${input.specialist} replied to the user] ${text}`, timestamp: Date.now() }]
      };

      const conversation = await this.#deps.conversation(chat);
      await conversation.submit({ type: "write", entry, requestId: `specialist-reply:${input.request}:${input.specialist}` }, this.#deps.context);
      this.#deps.answered(chat);
      feed.update(input.feedId, failed ? { status: text === "Stopped." ? "stopped" : "failed", summary: text } : { status: "done", summary: summarize(text) });

      if (!failed) feed.describe(input.feedId, text);
    };

    const task = defineTask<ReplyInput, ReplyState, null>({
      name: "ky.specialist-reply",
      version: 1,
      initial: () => ({ phase: "answer" }),
      phases: {
        answer: async (reply, runtime, context) => {
          const { input } = reply;
          feed.update(input.feedId, { status: "working" });
          const seat = (await runtime.conversation(input.seat, context))!;

          const submission = await seat.submit(
            // SAFETY: start() writes content from the user's input, a UserInput.
            { type: "input", content: input.content as UserInput, whenBusy: "followUp", requestId: `group:${input.request}` },
            context
          );

          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), REPLY_TIMEOUT_MS)));
          const settled = await Promise.race([submission.wait(context), late]);
          clearTimeout(timer);

          if (settled === "late") await seat.abort(context);

          return runtime.commit(async (tx) => {
            const next = (text: string, failed: boolean) => ({ status: "running", checkpoint: { phase: "post", text, failed } }) as const;

            if (settled === "late") return next(`Ran out of time (${REPLY_TIMEOUT_MS / 60_000} minutes) and stopped.`, true);

            if (settled.status === "unanswered") return next(settled.reason === "aborted" ? "Stopped." : `Couldn't answer: ${settled.reason}`, true);

            if (settled.type !== "input") return next("Couldn't answer.", true);
            // SAFETY: pi-durable types AssistantEntry as Entry<never>, but documents its `model` as [AssistantMessage].
            const message = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
            const text = textOf(message).trim();

            return text ? next(text, false) : next("Had nothing to say.", true);
          }, context);
        },
        post: async (reply, runtime, context) => {
          const { text, failed } = reply.state.checkpoint;
          await post(String(runtime.conversationId), reply.input, text, failed);

          return runtime.commit(() => terminal, context);
        }
      },
      abort: async (reply, runtime, context) => {
        await post(String(runtime.conversationId), reply.input, "Stopped.", true);

        return runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
      }
    });

    this.#reply = task;

    return { task, extension: defineExtension({ name: "group-chat", tasks: [task] }) };
  }

  /**
   * The user's message in a chat, before ky gets it: when it is for
   * specialists, post it and start their replies, and say who answers;
   * undefined when ky answers it. `request` is its operation id.
   */
  async submit(chat: string, input: UserInput, text: string, request: string): Promise<{ to: string[] } | undefined> {
    const { store } = this.#deps;
    const conversation = await this.#deps.conversation(chat);
    const recent = recentOf(projectEntries([...(await conversation.entries({}, 40, undefined, this.#deps.context)).items].reverse()));

    // A resend is decided as it was; routing again could pick others.
    let to = store.decided(chat, request);

    if (to === undefined) {
      const decided = await plan(text, store.members(chat), (members) => route(this.#deps.complete, members, recent, text));

      if ("refused" in decided) throw new Error(decided.refused);
      to = store.decide(chat, request, decided.to);
    }

    if (to.length === 0) return undefined;
    // Each write and submission below has a request id, so a resend, or a start cut short and started again, posts once.
    await this.#start(conversation, chat, input, text, to, recent, request);

    return { to };
  }

  async #start(conversation: Conversation, chat: string, input: UserInput, text: string, to: readonly string[], recent: string, request: string) {
    const data: ToSpecialistsData = { to: [...to] };

    await conversation.submit(
      {
        type: "write",
        requestId: `to-specialists:${request}`,
        entry: { kind: TO_SPECIALISTS, data, model: [{ role: "user", content: forThem(input, to), timestamp: Date.now() }] }
      },
      this.#deps.context
    );

    const images = Array.isArray(input) ? input.filter((part): part is ImageContent => part.type === "image") : [];
    const prompt: TextContent = { type: "text", text: seatPrompt(recent, text) };
    const content: UserInput = images.length === 0 ? prompt.text : [prompt, ...images];
    const started: Array<{ id: string; seat: ConversationId; feedId: string }> = [];

    await conversation.commit(async (tx) => {
      for (const id of to) {
        const seat = await this.#seat(tx, chat, id);
        const feedId = `group:${chat}:${request}:${id}`;
        // SAFETY: UserInput is JSON: text, or text and image parts.
        await tx.createTask(this.#reply!, { specialist: id, seat, content: content as JsonValue, request, feedId }, background(conversation.id));
        started.push({ id, seat, feedId });
      }
    }, this.#deps.context);

    for (const { id, seat, feedId } of started) {
      this.#deps.feed.create({ id: feedId, kind: "cloud", worker: `@${id}`, title: summarize(text).slice(0, 60), status: "working", session: String(seat) });
    }
  }

  /** The specialist's seat in the chat, on its model now; made the first time. */
  async #seat(tx: Tx, chat: string, id: string): Promise<ConversationId> {
    const seats = this.#seats!;
    const row = this.#deps.specialists.get(id);

    if (!row) throw new Error(`No specialist @${id}.`);
    const model = seats.model(row.model);
    const known = this.#deps.store.seat(chat, id);

    if (known !== undefined) {
      // SAFETY: a seat is the id, as text, of a conversation made below.
      const seat = Number(known) as ConversationId;
      await configure(tx, seat, agentModel(model));

      return seat;
    }

    const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await setUp(tx, child.id, seats.remove, model);
    this.#deps.specialists.attach(String(child.id), id, "group");
    this.#deps.store.sit(chat, id, String(child.id));

    return child.id;
  }
}
