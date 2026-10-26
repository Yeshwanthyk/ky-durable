import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { ROOT_SESSION } from "../../invariants/pi";
import type { Json } from "../kit";
import { StoredRow } from "../skills/storage";

export const START = Date.UTC(2026, 0, 1);

export const DAY = 86_400_000;

export const CHATS = new Map([
  [ROOT_SESSION, ""],
  ["2", "Trip"],
  ["3", "Work"]
]);

export const CONVERSATIONS = [ROOT_SESSION, "2", "3", "9"] as const;

export const UUID = "5a810bd0-46f4-43eb-8060-2a379fb357a5";

const LONG = `ferry ${"Lisbon tram plan ".repeat(320)}end`;

export const TEXTS = [
  "Plan a ferry to Lisbon",
  "The night tram in Lisbon",
  "Kyoto in spring, then a ferry",
  "zanzibar  ferry\n\nsee you",
  "budget for the trip: 300",
  "   ",
  "",
  "ferry",
  "tram café über",
  LONG
] as const;

export const QUERIES = ["ferry", "ferry Lisbon", "ferry zanzibar", "Kyoto", "tram", "café", "?!", "", "  Lisbon  ", "nothing here", "über tram"] as const;

export type Origin = "own" | "relay" | "far" | "none";

export type Say = {
  readonly _tag: "say";
  readonly conversation: string;
  readonly kind: "user" | "assistant" | "look" | "reset" | "tool";
  readonly text: string;
  readonly parts: boolean;
  readonly stop: "stop" | "length" | "toolUse" | "aborted";
  readonly origin: Origin;
  readonly placed: boolean;
  readonly late: boolean;
  readonly sameCommit: boolean;
};

export type Action =
  | Say
  | { readonly _tag: "search"; readonly query: string; readonly around: number; readonly caller: string; readonly batches: number | null; readonly span: { readonly from: number; readonly to: number } | null }
  | { readonly _tag: "since"; readonly seq: number; readonly back: number; readonly chars: number; readonly now: number | null }
  | { readonly _tag: "latest"; readonly session: string }
  | { readonly _tag: "rebuild" }
  | { readonly _tag: "reopen"; readonly downgrade: "none" | "roles" | "column" }
  | { readonly _tag: "forget"; readonly back: number }
  | { readonly _tag: "placedBy"; readonly back: readonly number[] }
  | { readonly _tag: "ownMessages"; readonly back: readonly number[] }
  | { readonly _tag: "startedByUser"; readonly conversation: string }
  | { readonly _tag: "runOpener"; readonly conversation: string; readonly back: number | null }
  | { readonly _tag: "runInputs"; readonly conversation: string }
  | { readonly _tag: "wroteSince"; readonly conversation: string; readonly ago: number };

const aConversation = fc.constantFrom(...CONVERSATIONS);

const say: fc.Arbitrary<Action> = fc.record({
  _tag: fc.constant("say" as const),
  conversation: aConversation,
  kind: fc.constantFrom("user", "user", "assistant", "assistant", "look", "reset", "tool"),
  text: fc.constantFrom(...TEXTS),
  parts: fc.boolean(),
  stop: fc.constantFrom("stop", "stop", "length", "toolUse", "aborted"),
  origin: fc.constantFrom("own", "own", "relay", "far", "none"),
  placed: fc.boolean(),
  late: fc.boolean(),
  sameCommit: fc.boolean()
});

const back = fc.integer({ min: 0, max: 12 });

export const actions: fc.Arbitrary<Action> = fc.oneof(
  { weight: 6, arbitrary: say },
  {
    weight: 3,
    arbitrary: fc.record({
      _tag: fc.constant("search" as const),
      query: fc.constantFrom(...QUERIES),
      around: fc.constantFrom(0, 0, 1, 2),
      caller: fc.constantFrom(...CONVERSATIONS, ""),
      batches: fc.constantFrom(null, null, 1, 0),
      span: fc.option(fc.record({ from: fc.integer({ min: -2, max: 12 }).map((day) => START + day * DAY), to: fc.integer({ min: -1, max: 14 }).map((day) => START + day * DAY) }))
    })
  },
  {
    weight: 2,
    arbitrary: fc.record({
      _tag: fc.constant("since" as const),
      seq: fc.constantFrom(0, 0, 1, 3, 8, 20),
      back: fc.constantFrom(0, DAY, 8 * DAY, 30 * DAY),
      chars: fc.constantFrom(40, 120, 400, 2_000, 20_000),
      now: fc.option(fc.integer({ min: -9, max: 3 }).map((days) => days * DAY))
    })
  },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("latest" as const), session: aConversation }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("rebuild" as const) }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("reopen" as const), downgrade: fc.constantFrom("none", "roles", "column") }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("forget" as const), back }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("placedBy" as const), back: fc.array(back, { maxLength: 4 }) }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("ownMessages" as const), back: fc.array(back, { maxLength: 4 }) }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("startedByUser" as const), conversation: aConversation }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("runOpener" as const), conversation: aConversation, back: fc.option(back) }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("runInputs" as const), conversation: aConversation }) },
  { weight: 1, arbitrary: fc.record({ _tag: fc.constant("wroteSince" as const), conversation: aConversation, ago: fc.constantFrom(0, 1, DAY, 10 * DAY) }) }
);

export const advances = fc.oneof(fc.integer({ min: 0, max: 120_000 }), fc.constantFrom(DAY, 3 * DAY, 7 * DAY));

const PI_TABLES = [
  "CREATE TABLE pi_entries (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, head INTEGER, commit_seq INTEGER NOT NULL, record TEXT NOT NULL CHECK (json_valid(record))) STRICT",
  "CREATE TABLE pi_submissions (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, request_id TEXT, status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')), record TEXT NOT NULL CHECK (json_valid(record))) STRICT"
];

export function sqlOf(db: DatabaseSync) {
  return {
    exec: (query: string, ...bindings: SQLInputValue[]) => {
      const rows = Schema.decodeUnknownSync(Schema.Array(StoredRow))(db.prepare(query).all(...bindings)).map((row) => ({ ...row }));
      const cursor = rows.values();

      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);

          return rows[0];
        },
        [Symbol.iterator]: (): IterableIterator<(typeof rows)[number]> => cursor
      };
    }
  };
}

export function transactionOf(db: DatabaseSync) {
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

  return transactionSync;
}

type SearchOptions = { around?: number; caller?: string; batches?: number; span?: { from: number; to: number; days: string } };

export type Side = {
  search(query: string, options: SearchOptions): string;
  since(from: { seq: number; at: number }, chars: number, now?: number): Json;
  latest(session: string): string | null;
  rebuild(): void;
};

export type Reads = {
  placedBy(users: readonly number[]): ReadonlyMap<number, string | undefined>;
  ownMessages(users: readonly number[]): ReadonlySet<number>;
  startedByUser(conversation: string): boolean;
  runOpener(conversation: string, before?: number): number | undefined;
  runInputs(conversation: string): readonly { entry: number; request: string | undefined }[];
  wroteSince(conversation: string, at: number): boolean;
};

export type Make = { readonly open: (db: DatabaseSync) => Side; readonly reads: (db: DatabaseSync) => Reads };

const isChat = (session: string) => CHATS.has(session);

export const nameOf = (session: string) => CHATS.get(session) || "untitled";

export const chatSide = { isChat, name: nameOf };

const rowsOf = (db: DatabaseSync, query: string): Json[] => Schema.decodeUnknownSync(Schema.Array(StoredRow))(db.prepare(query).all()).map((row) => ({ ...row }));

function recordOf(action: Say, at: number): string {
  const content = action.parts ? [{ type: "thinking", thinking: "hmm" }, { type: "text", text: action.text }, { type: "image", data: "x" }, { type: "text", text: "and so" }] : action.text;

  if (action.kind === "look") return JSON.stringify({ kind: "ky.look", data: { text: action.text }, model: [{ role: "user", content: action.text, timestamp: at }] });

  if (action.kind === "reset") return JSON.stringify({ kind: "pi.reset", model: [] });

  if (action.kind === "tool") return JSON.stringify({ kind: "pi.tool", model: [{ role: "toolResult", content, timestamp: at }] });

  if (action.kind === "user") return JSON.stringify({ kind: "pi.user", model: [{ role: "user", content, timestamp: at }] });

  return JSON.stringify({ kind: "pi.assistant", model: [{ role: "assistant", content, timestamp: at, stopReason: action.stop }] });
}

function piDatabase() {
  const db = new DatabaseSync(":memory:");

  for (const statement of PI_TABLES) db.exec(statement);

  return db;
}

export function world(make: Make, now: () => number) {
  const db = piDatabase();

  let side = make.open(db);
  let next = 1;
  let seq = 0;
  const ids: number[] = [];
  const holes: number[] = [];

  const idBack = (back: number) => ids.at(-1 - (back % Math.max(1, ids.length))) ?? 0;

  const write = (action: Say) => {
    const at = now();
    const hole = action.late ? holes.pop() : undefined;
    const id = hole ?? next;

    if (hole === undefined) {
      next += 2;
      holes.push(id + 1);
    }

    if (!action.sameCommit || seq === 0) seq++;
    db.prepare("INSERT INTO pi_entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, ?, ?)").run(id, Number(action.conversation), seq, recordOf(action, at));
    ids.push(id);

    if (action.kind !== "user" || action.origin === "none") return id;

    const request = action.origin === "own" ? UUID : action.origin === "relay" ? `mail:${id}` : UUID;
    const submission = action.origin === "far" ? id * 10 + 6_000 : id * 10 + 1;

    db.prepare("INSERT INTO pi_submissions (id, conversation_id, request_id, status, record) VALUES (?, ?, ?, ?, ?)").run(
      submission,
      Number(action.conversation),
      request,
      action.placed ? "placed" : "done",
      JSON.stringify({ entry: id, requestId: request })
    );

    return id;
  };

  const reads = make.reads(db);

  const apply = (action: Action): Json => {
    switch (action._tag) {
      case "say":
        return write(action);
      case "search": {
        const options: SearchOptions = { around: action.around, caller: action.caller };

        if (action.batches !== null) options.batches = action.batches;

        if (action.span) options.span = { ...action.span, days: `between ${action.span.from} and ${action.span.to}` };

        return side.search(action.query, options);
      }

      case "since":
        return side.since({ seq: action.seq, at: now() - action.back }, action.chars, action.now === null ? undefined : now() + action.now);
      case "latest":
        return side.latest(action.session);
      case "rebuild":
        side.rebuild();

        return null;
      case "reopen":
        if (action.downgrade === "roles") db.exec("UPDATE ky_history_mark SET roles = 0");

        if (action.downgrade === "column") {
          db.exec("CREATE TABLE ky_history_mark_old AS SELECT id, last FROM ky_history_mark");
          db.exec("DROP TABLE ky_history_mark");
          db.exec("CREATE TABLE ky_history_mark (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL)");
          db.exec("INSERT INTO ky_history_mark SELECT * FROM ky_history_mark_old");
          db.exec("DROP TABLE ky_history_mark_old");
        }

        side = make.open(db);

        return null;
      case "forget":
        db.prepare("DELETE FROM pi_entries WHERE id = ?").run(idBack(action.back));

        return null;
      case "placedBy":
        return [...reads.placedBy(action.back.map(idBack))].map(([entry, request]) => [entry, request ?? null]);
      case "ownMessages":
        return [...reads.ownMessages(action.back.map(idBack))];
      case "startedByUser":
        return reads.startedByUser(action.conversation);
      case "runOpener":
        return (action.back === null ? reads.runOpener(action.conversation) : reads.runOpener(action.conversation, idBack(action.back))) ?? null;
      case "runInputs":
        return reads.runInputs(action.conversation).map(({ entry, request }) => ({ entry, request: request ?? null }));
      case "wroteSince":
        return reads.wroteSince(action.conversation, now() - action.ago);
    }
  };

  return {
    db,
    apply,
    reads,
    side: () => side,
    ids: () => [...ids],
    tables: (): Json => ({
      index: rowsOf(db, "SELECT rowid, text, conversation, role, at FROM ky_history ORDER BY rowid"),
      mark: rowsOf(db, "SELECT * FROM ky_history_mark"),
      schema: rowsOf(db, "SELECT type, name FROM sqlite_master WHERE name LIKE 'ky_%' ORDER BY name")
    })
  };
}
