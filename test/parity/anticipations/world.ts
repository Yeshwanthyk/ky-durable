import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, SettledSubmissionRecord, Submission, ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { TaskFeed } from "../../../src/automations/contract";
import { Anticipating, anticipateTool } from "../../../src/dreaming/anticipations";
import { Memory } from "../../../src/dreaming/memory";
import { Surfaced } from "../../../src/dreaming/surfaced";
import type { History } from "../../../src/history/wiring";
import type { ReviewHost } from "../../../src/skills/contract";
import { Reviews, Skills } from "../../../src/skills/wiring";
import type { Json } from "../kit";
import { StoredRow } from "../skills/storage";

export const START = Date.UTC(2026, 9, 26, 12);

export const HOUR = 3_600_000;

export const DAY = 24 * HOUR;

export type Role = "user" | "notice" | "ky";

export const SEED: readonly (readonly [number, Role])[] = [
  [1, "user"],
  [1, "ky"],
  [1, "notice"],
  [1, "ky"],
  [1, "user"],
  [2, "user"],
  [2, "ky"],
  [2, "notice"],
  [7, "notice"],
  [7, "ky"]
];

export const MEMORIES = ["the user likes green tea", "a trip to Lisbon in May"];

export const CHATS: ReadonlySet<string> = new Set(["1", "2"]);

const PASS = { parent: "1", after: 2, upto: 12 };

export const actorOf = (session: string) => (CHATS.has(session) ? ("user" as const) : session === "5" ? ("episode" as const) : ("dream" as const));

export const passOf = (session: string) => (session === "5" ? PASS : undefined);

export const listOnly = (session: string) => session === "8";

export const isDream = (session: string) => session === "7";

const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;

type Seen = { closed: number; changed: number; later: number[]; cards: string[]; sessions: number };

type Tool = ReturnType<typeof anticipateTool>;

type CheckIns = { readonly on: boolean; readonly zone: string | null; readonly waiting: string[] };

export type Here = {
  readonly db: DatabaseSync;
  readonly memory: Memory;
  readonly seen: Seen;
  readonly said: string[];
  answered: boolean;
  checkInsOn: boolean;
};

export type DreamWorld = {
  readonly history: History;
  readonly later: (at: number) => Promise<void>;
  readonly memory: Memory;
  readonly skills: Skills;
  readonly reviews: Reviews;
  readonly host: ReviewHost;
  readonly create: () => Promise<string>;
  readonly checkIns: () => Promise<CheckIns>;
};

const stored = Schema.decodeUnknownSync(StoredRow);

type Cell = Record<string, string | number | null>;

function cursorsOf(db: DatabaseSync) {
  return {
    exec: (query: string, ...bindings: SQLInputValue[]) => {
      const rows: Cell[] = db
        .prepare(query)
        .all(...bindings)
        .map((row) => ({ ...stored(row) }));

      return { [Symbol.iterator]: (): IterableIterator<Cell> => rows[Symbol.iterator](), toArray: () => rows, one: () => rows[0] };
    }
  };
}

export function anticipatingFor(world: Here, closed: () => void) {
  const deps = { memory: world.memory, chat: (session: string) => CHATS.has(session), entries: cursorsOf(world.db), closed };

  // SAFETY: the anticipations read sql.exec of the entries as a cursor (iterated, toArray, one), nothing else of the sql.
  return Anticipating.layer(deps as Parameters<typeof Anticipating.layer>[0]);
}

export function storageFor(db: DatabaseSync): ConstructorParameters<typeof Surfaced>[0] {
  const transactionSync = <T>(work: () => T): T => {
    db.exec("SAVEPOINT tx");

    try {
      const done = work();
      db.exec("RELEASE tx");

      return done;
    } catch (error) {
      db.exec("ROLLBACK TO tx");
      db.exec("RELEASE tx");
      throw error;
    }
  };

  // SAFETY: the stores read sql and transactionSync, nothing else of the storage.
  return { sql: cursorsOf(db), transactionSync } as ConstructorParameters<typeof Surfaced>[0];
}

export function enter(db: DatabaseSync, conversation: number, role: Role): number {
  const kind = role === "ky" ? "pi.assistant" : "pi.user";
  const { lastInsertRowid } = db.prepare("INSERT INTO pi_entries (conversation_id, record) VALUES (?, ?)").run(conversation, JSON.stringify({ kind }));
  const id = Number(lastInsertRowid);

  if (role !== "ky") db.prepare("INSERT INTO pi_submissions (id, record) VALUES (?, ?)").run(id, JSON.stringify({ entry: id, requestId: role === "user" ? uuid(id) : `mail:${id}` }));

  return id;
}

export function here(): Here {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE pi_entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, record TEXT NOT NULL)");
  db.exec("CREATE TABLE pi_submissions (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");

  for (const [conversation, role] of SEED) enter(db, conversation, role);
  const memory = new Memory(storageFor(db), () => Promise.reject(new Error("no compressor")));

  for (const text of MEMORIES) memory.note(text);

  return { db, memory, seen: { closed: 0, changed: 0, later: [], cards: [], sessions: 0 }, said: [], answered: true, checkInsOn: false };
}

export function dreamOf(world: Here): DreamWorld {
  const history: Pick<History, "since"> = {
    since: (from: { readonly seq: number }) => ({ lines: world.said.slice(Math.max(0, from.seq - SEED.length)), dropped: 0, waiting: 0, through: SEED.length + world.said.length })
  };

  // SAFETY: the dream reads only status, type and reason of the settled submission.
  const settled = () =>
    (world.answered ? { status: "done" as const, type: "write" as const } : { status: "unanswered" as const, type: "input" as const, reason: "aborted" }) as SettledSubmissionRecord;

  const submission: Pick<Submission, "wait"> = { wait: async () => settled() };
  // SAFETY: the dream only waits on the submission.
  const conversation: Pick<Conversation, "id" | "submit"> = { id: 99 as ConversationId, submit: async () => submission as Submission };

  const feed: Pick<TaskFeed, "create" | "update" | "finishedSince"> = {
    create: (card) => {
      world.seen.cards.push(`${card.title} ${card.status}`);

      return { source: "", summary: "", steps: [], agent: null, chat: null, created_at: 0, updated_at: 0, started_at: null, finished_at: null, turns: null, cost_usd: null, ...card, model: card.model ?? null };
    },
    update: (_id, change) => void world.seen.cards.push(change.status ?? ""),
    finishedSince: () => []
  };

  const host: ReviewHost = {
    // SAFETY: the dream only submits to the conversation.
    conversation: async () => conversation as Conversation,
    // SAFETY: the dream creates, updates and reads finished cards of the feed, nothing else.
    feed: feed as TaskFeed,
    later: () => undefined,
    context: BACKGROUND_CONTEXT,
    model: () => ({}),
    allows: () => true
  };

  return {
    // SAFETY: the dream reads only since() of the history.
    history: history as History,
    later: async (at) => void world.seen.later.push(at),
    memory: world.memory,
    skills: new Skills(storageFor(world.db)),
    reviews: new Reviews(storageFor(world.db)),
    host,
    create: async () => String(100 + ++world.seen.sessions),
    checkIns: async () => ({ on: world.checkInsOn, zone: null, waiting: world.checkInsOn ? ["water the plants"] : [] })
  };
}

const plain = Schema.decodeUnknownSync(Schema.MutableJson);

export function json<Value>(value: Value): Json {
  return plain(JSON.parse(JSON.stringify(value instanceof Map ? [...value] : value) ?? "null"));
}

const TextPart = Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) });

const ToolReply = Schema.Struct({ output: Schema.Array(TextPart) });

const replyOf = Schema.decodeUnknownSync(ToolReply);

export type ToolArgs = Readonly<Record<string, string | number | readonly number[]>>;

export async function callTool(tool: Tool, session: string, args: ToolArgs): Promise<string> {
  // SAFETY: the anticipate tool reads only the calling conversation of the api.
  const api = { conversationId: Number(session), taskId: 1, callId: "call-1" } as ToolExecutionApi;
  // SAFETY: args come from anArgs, shaped as the tool's parameters.
  const reply = replyOf(await tool.execute(args as never, api, BACKGROUND_CONTEXT));

  return reply.output.map((part) => part.text ?? "").join("");
}

export async function refusalOf<T>(work: () => T | Promise<T>): Promise<{ readonly ok: Awaited<T> } | { readonly refused: string }> {
  try {
    return { ok: await work() };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

const iso = (hours: number) => new Date(START + hours * HOUR).toISOString();

const aWhen = fc.oneof({ arbitrary: fc.integer({ min: -30, max: 200 }).map(iso), weight: 8 }, { arbitrary: fc.constantFrom("soon", "2026-13-45T00:00:00Z"), weight: 1 });

export const TEXTS = ["Reply to Sam about the lease", "Book the dentist", "tea with Ana", "Lisbon trip in May", "", "  ", "two\nlines", "x".repeat(280), "x".repeat(281), "é".repeat(141)];

export const TERMS = ["lease", "sam", "tea", "lisbon", "may", "dentist", "x", "zz"];

export const anArgs = fc.record(
  {
    action: fc.constantFrom("add", "add", "add", "add", "add", "close", "close", "extend", "absorb", "pin", "unpin", "list", "list"),
    id: fc.integer({ min: 1, max: 5 }),
    kind: fc.constantFrom("open_loop", "upcoming", "predicted_ask", "watch", "someday"),
    text: fc.constantFrom(...TEXTS),
    messages: fc.subarray([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 99], { maxLength: 3 }),
    memories: fc.subarray([0, 1, 7], { maxLength: 2 }),
    prepared: fc.constantFrom("", "Sam's lease ends in March", "p".repeat(1500), "p".repeat(1501)),
    from: aWhen,
    to: aWhen,
    outcome: fc.constantFrom("done", "dismissed"),
    note: fc.constantFrom("Sam signed the lease", "", " "),
    into: fc.integer({ min: 1, max: 5 }),
    about: fc.constantFrom("lease", "Sam tea", "x", "lisbon, may", "dentist"),
    hours: fc.integer({ min: 1, max: 168 })
  },
  { requiredKeys: ["action"] }
);

const aWindow = fc.option(
  fc.tuple(fc.integer({ min: -30, max: 48 }), fc.integer({ min: 1, max: 96 })).map(([from, length]) => ({ from: iso(from), to: iso(from + length) })),
  { nil: undefined }
);

export const aGoodAdd = fc
  .tuple(
    fc.record({
      action: fc.constant("add"),
      kind: fc.constantFrom("open_loop", "upcoming", "predicted_ask", "watch"),
      text: fc.constantFrom(...TEXTS.slice(0, 4)),
      messages: fc.subarray([1, 5, 6], { minLength: 1, maxLength: 2 }),
      memories: fc.subarray([0, 1], { maxLength: 1 }),
      prepared: fc.constantFrom("", "Sam's lease ends in March")
    }),
    aWindow
  )
  .map(([args, window]) => ({ ...args, ...window }));

export const aChange = fc.record(
  {
    action: fc.constantFrom("close", "close", "extend", "absorb", "pin", "unpin"),
    id: fc.integer({ min: 1, max: 3 }),
    outcome: fc.constantFrom("done", "dismissed"),
    note: fc.constantFrom("Sam signed the lease", "", " "),
    from: fc.integer({ min: -30, max: 48 }).map(iso),
    to: fc.integer({ min: -10, max: 120 }).map(iso),
    into: fc.integer({ min: 1, max: 3 })
  },
  { requiredKeys: ["action", "id", "outcome", "to", "into"] }
);

export const aSession = fc.constantFrom("1", "1", "1", "2", "5", "7", "7", "8");

export const advances = fc.oneof(fc.integer({ min: 1_000, max: HOUR }), fc.integer({ min: HOUR, max: 3 * DAY }));
