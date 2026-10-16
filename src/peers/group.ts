import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
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
import { decodeOr, parseOr } from "../core/decode";
import { must } from "../core/must";
import { refused } from "../core/refusal";
import { agentModel } from "../models";
import type { ModelChoice } from "../settings";
import { mentions, setUp, type SpecialistRow, type Specialists, textOf } from "../skills/contract";
import { summarize, type TaskFeed } from "../automations/contract";
import {
  FOR_MARK,
  type PiMessage,
  projectEntries,
  SPECIALIST_REPLY,
  type SpecialistReplyData,
  TO_SPECIALISTS,
  type ToSpecialistsData
} from "../transcript";
import {
  ChatMember,
  type GroupMembers,
  PEERS_TABLES,
  type PostCheckpoint,
  RESPONDER_CAP,
  ResponderRow,
  Responders,
  type ReplyOutcome,
  type RoutePlan,
  SeatRow
} from "./contract";

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

/** How long a specialist has for one reply before its seat is stopped. */
const REPLY_TIMEOUT_MS = 4 * 60_000;

/** The chat a specialist and the router see: this many recent messages, each and all cut. */
const RECENT_MESSAGES = 8;

const RECENT_LINE_CHARS = 600;

const RECENT_CHARS = 3_000;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

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

  if (mentioned.length > RESPONDER_CAP) return refused(`At most ${RESPONDER_CAP} specialists can answer one message.`);

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

const { chatMembers: MEMBERS, seats: SEATS, groupMessages: MESSAGES } = PEERS_TABLES;

/** Chats' members, specialists' seats in chats, and the decision on each message, by its operation id. */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS ${MEMBERS} (
    chat TEXT NOT NULL,
    specialist TEXT NOT NULL,
    PRIMARY KEY (chat, specialist))`,
  `CREATE TABLE IF NOT EXISTS ${SEATS} (
    chat TEXT NOT NULL,
    specialist TEXT NOT NULL,
    session TEXT NOT NULL,
    PRIMARY KEY (chat, specialist))`,
  `CREATE TABLE IF NOT EXISTS ${MESSAGES} (
    chat TEXT NOT NULL,
    request TEXT NOT NULL,
    responders TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat, request))`
];

/** Rows as `schema` says; a row a restore or an old version damaged is left out. */
function rows<Schema extends TSchema>(schema: Schema, cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): Array<Static<Schema>> {
  return cursor.toArray().flatMap((row) => {
    const checked = decodeOr(schema, row, undefined);

    return checked === undefined ? [] : [checked];
  });
}

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
    return rows(ChatMember, this.#sql.exec(`SELECT chat, specialist FROM ${MEMBERS} WHERE chat = ? ORDER BY specialist`, chat)).flatMap(
      ({ specialist }) => this.#specialists.get(specialist) ?? []
    );
  }

  /** Every group chat's member ids; a chat with none is not in it. */
  all(): GroupMembers {
    const groups = new Map<string, string[]>();

    for (const { chat, specialist } of rows(ChatMember, this.#sql.exec(`SELECT chat, specialist FROM ${MEMBERS} ORDER BY specialist`))) {
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
    this.#sql.exec(`DELETE FROM ${MEMBERS} WHERE chat = ?`, chat);

    for (const id of new Set(ids)) this.#sql.exec(`INSERT INTO ${MEMBERS} (chat, specialist) VALUES (?, ?)`, chat, id);
    this.#emit();
  }

  /** The specialist's seat in the chat, made on its first reply there. */
  seat(chat: string, id: string): string | undefined {
    return rows(SeatRow, this.#sql.exec(`SELECT session FROM ${SEATS} WHERE chat = ? AND specialist = ?`, chat, id))[0]?.session;
  }

  sit(chat: string, id: string, session: string): void {
    this.#sql.exec(`INSERT OR REPLACE INTO ${SEATS} (chat, specialist, session) VALUES (?, ?, ?)`, chat, id, session);
  }

  /** Who a message was decided for, if it was; damaged responders read as none, so ky answers it. */
  decided(chat: string, request: string): string[] | undefined {
    const row = rows(ResponderRow, this.#sql.exec(`SELECT responders FROM ${MESSAGES} WHERE chat = ? AND request = ?`, chat, request))[0];

    return row && parseOr(Responders, row.responders, []);
  }

  /** Record who answers a message; the first decision stands, and is returned. */
  decide(chat: string, request: string, responders: readonly string[]): string[] {
    this.#sql.exec(
      `INSERT OR IGNORE INTO ${MESSAGES} (chat, request, responders, created_at) VALUES (?, ?, ?, ?)`,
      chat,
      request,
      JSON.stringify(responders),
      Date.now()
    );

    return must(this.decided(chat, request), "a decision was just written");
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

type ReplyState = { phase: "answer" } | PostCheckpoint;

const STOPPED: ReplyOutcome = { kind: "stopped", text: "Stopped." };

/** A checkpoint's outcome; one written before outcomes says only whether it failed. */
function outcomeOf(checkpoint: PostCheckpoint): ReplyOutcome {
  if ("outcome" in checkpoint) return checkpoint.outcome;

  return { kind: checkpoint.failed ? "failed" : "answered", text: checkpoint.text };
}

/** What Activity shows for a reply's task. */
function feedUpdate(outcome: ReplyOutcome) {
  if (outcome.kind === "answered") return { status: "done", summary: summarize(outcome.text) } as const;

  return { status: outcome.kind === "stopped" ? "stopped" : "failed", summary: outcome.text } as const;
}

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
    const post = async (chat: string, input: ReplyInput, outcome: ReplyOutcome) => {
      const { text } = outcome;
      const failed = outcome.kind !== "answered";
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
      feed.update(input.feedId, feedUpdate(outcome));

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
          const seat = must(await runtime.conversation(input.seat, context), `@${input.specialist}'s seat is gone`);

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
            const next = (outcome: ReplyOutcome) => ({ status: "running", checkpoint: { phase: "post", outcome } }) as const;
            const failed = (text: string) => next({ kind: "failed", text });

            if (settled === "late") return failed(`Ran out of time (${REPLY_TIMEOUT_MS / 60_000} minutes) and stopped.`);

            if (settled.status === "unanswered") return settled.reason === "aborted" ? next(STOPPED) : failed(`Couldn't answer: ${settled.reason}`);

            if (settled.type !== "input") return failed("Couldn't answer.");
            // SAFETY: pi-durable types AssistantEntry as Entry<never>, but documents its `model` as [AssistantMessage].
            const message = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
            const text = textOf(message).trim();

            return text ? next({ kind: "answered", text }) : failed("Had nothing to say.");
          }, context);
        },
        post: async (reply, runtime, context) => {
          await post(String(runtime.conversationId), reply.input, outcomeOf(reply.state.checkpoint));

          return runtime.commit(() => terminal, context);
        }
      },
      abort: async (reply, runtime, context) => {
        await post(String(runtime.conversationId), reply.input, STOPPED);

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
        await tx.createTask(must(this.#reply, "the reply task is defined once pi opens"), { specialist: id, seat, content: content as JsonValue, request, feedId }, background(conversation.id));
        started.push({ id, seat, feedId });
      }
    }, this.#deps.context);

    for (const { id, seat, feedId } of started) {
      this.#deps.feed.create({ id: feedId, kind: "cloud", worker: `@${id}`, title: summarize(text).slice(0, 60), status: "working", session: String(seat), chat });
    }
  }

  /** The specialist's seat in the chat, on its model now; made the first time. */
  async #seat(tx: Tx, chat: string, id: string): Promise<ConversationId> {
    const seats = must(this.#seats, "seats are set up once pi opens");
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
