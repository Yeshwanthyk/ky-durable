import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import {
  ANTICIPATE,
  ANTICIPATION_KINDS,
  type Anticipation,
  type AnticipationKind,
  anticipationRow,
  type AnticipationStatus,
  countOf,
  type Creator,
  type Evidence
} from "./contract";
import type { Brief } from "./brief";
import type { Memory } from "./memory";

/**
 * Anticipations: what ky expects to matter soon, so the right context is ready before the user reaches for
 * it. A row is an open loop the user committed to, a date ahead, a question likely next, or a condition worth
 * watching; each cites the chat messages or memories it rests on, and the store refuses one that cites
 * nothing or something that is not there. Facts go to memory (OptMem); only what is still open lives here.
 * When a loop closes as done, memory gets one note with the outcome, so it keeps the history.
 *
 * Who calls what (docs/research/proactivity/dreaming-proactivity.md):
 * - the nightly dream (src/dreaming/dreaming.ts): `expire` at its start, `open` for its digest, and through
 *   the `anticipate` tool `add`, `close`, `extend` and `absorb` on its own rows;
 * - the main chat, for the user ("remind me", "that's done"), through the same tool, as `user`;
 * - turn-start recall: `match` the message's words (the tool's list `about` uses it today);
 * - the morning brief (src/dreaming/brief.ts): the dream's digest lists `due` for the day ahead, and the tool's
 *   `brief` action puts a row in it and marks it `surface`d; the card's pin is `pin`, and its dismiss `close`s
 *   the row as dismissed for the user;
 * - Settings › Proactivity: `madeSince`, for how many expired unseen;
 * - the panel, later: `open`, `pin`/`unpin` (the tool's, for the user, today), and `close` as dismissed.
 *
 * Status moves only forward: open → surfaced → done | dismissed, and open → done | dismissed | expired.
 * A machine (the dream, an episode review) may change only rows a machine made, and never a pinned one.
 */

/** Open rows (open or surfaced) past which a machine may add no more. */
const OPEN_CAP = 20;

/** Rows a dream may add in one run. */
export const RUN_CAP = 5;

/** A dream's run, for RUN_CAP: rows the dream added this long ago or less count against it. */
const RUN_MS = 12 * 3_600_000;

const TEXT_BYTES = 280;

const PREPARED_CHARS = 1_500;

/** Words `match` reads, at most, and the shortest it reads. */
const MATCH_TERMS = 12;

const TERM_CHARS = 3;

/** Who acts on a row: whoever may make one. */
export type Actor = Creator;

/** When a row matters, epoch ms; to is never before from. */
export type Window = { readonly from: number; readonly to: number };

/** A new row, as its maker states it. */
export type Draft = {
  readonly kind: AnticipationKind;
  readonly text: string;
  readonly evidence: Evidence;
  readonly prepared?: string;
  readonly window?: Window;
};

/** The legal moves; anything else is refused. */
const MOVES: Readonly<Record<AnticipationStatus, readonly AnticipationStatus[]>> = {
  open: ["surfaced", "done", "dismissed", "expired"],
  surfaced: ["done", "dismissed"],
  done: [],
  dismissed: [],
  expired: []
};

const LIVE = "status IN ('open', 'surfaced')";

const encoder = new TextEncoder();

const bytes = (text: string) => encoder.encode(text).length;

/** A one-line text of at most TEXT_BYTES bytes, or an error saying what is wrong. */
function checkText(text: string): string {
  const line = text.trim();

  if (line === "") throw new Error("Empty. An anticipation is one line of text.");

  if (/[\r\n]/.test(line)) throw new Error("An anticipation is one line.");

  if (bytes(line) > TEXT_BYTES) throw new Error(`Too long: ${bytes(line)} bytes, limit ${TEXT_BYTES}.`);

  return line;
}

function checkWindow(window: Window): Window {
  if (!Number.isFinite(window.from) || !Number.isFinite(window.to)) throw new Error("A window needs a from and a to that are dates.");

  if (window.to < window.from) throw new Error("A window's to is before its from.");

  return window;
}

/** `pattern` as a LIKE pattern that matches it anywhere, its wildcards escaped. */
const like = (term: string) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export class Anticipations {
  readonly #sql: SqlStorage;
  readonly #memory: Memory;

  constructor(sql: SqlStorage, memory: Memory) {
    this.#sql = sql;
    this.#memory = memory;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_anticipations (
      id INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      evidence TEXT NOT NULL,
      prepared TEXT,
      window_from INTEGER,
      window_to INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      pinned INTEGER NOT NULL DEFAULT 0,
      absorbed_into INTEGER,
      closed_at INTEGER)`);
  }

  #rows(query: string, ...bindings: SqlStorageValue[]): Anticipation[] {
    return this.#sql.exec(query, ...bindings).toArray().flatMap((raw) => anticipationRow(raw) ?? []);
  }

  /** The row `id`, or an error when there is none. */
  get(id: number): Anticipation {
    const row = this.#rows("SELECT * FROM ky_anticipations WHERE id = ?", id)[0];

    if (row === undefined) throw new Error(`No anticipation #${id}.`);

    return row;
  }

  /**
   * Add a row by `by`. Refused when its evidence is empty or cites a message or memory that is not there, when
   * its text or prepared context is over its limit, when an upcoming one has no window, and for a machine when
   * OPEN_CAP rows are open or, for a dream, when it added RUN_CAP this run. The user's own always fit.
   */
  add(draft: Draft, by: Creator, now = Date.now()): Anticipation {
    const { text, prepared, window } = checkDraft(draft);
    const evidence = this.checkEvidence(draft.evidence);

    this.#checkRoom(by, now);

    const row = this.#rows(
      `INSERT INTO ky_anticipations (created_at, created_by, kind, text, evidence, prepared, window_from, window_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      now,
      by,
      draft.kind,
      text,
      JSON.stringify(evidence),
      prepared ?? null,
      window?.from ?? null,
      window?.to ?? null
    )[0];

    if (row === undefined) throw new Error("The anticipation was not saved.");

    return row;
  }

  /** Refuse a machine's add while OPEN_CAP rows are live, and a dream's once it added RUN_CAP this run. */
  #checkRoom(by: Creator, now: number): void {
    if (by !== "user" && this.#count(`SELECT COUNT(*) AS n FROM ky_anticipations WHERE ${LIVE}`) >= OPEN_CAP) {
      throw new Error(`${OPEN_CAP} are open already: close or absorb one first.`);
    }

    if (by === "dream" && this.#count("SELECT COUNT(*) AS n FROM ky_anticipations WHERE created_by = 'dream' AND created_at > ?", now - RUN_MS) >= RUN_CAP) {
      throw new Error(`A dream adds at most ${RUN_CAP}; this one has.`);
    }
  }

  /** Evidence with each id once, when it cites at least one id and every id is there; an error saying what is wrong otherwise. */
  checkEvidence(evidence: Evidence): Evidence {
    const messages = [...new Set(evidence.messages)];
    const memories = [...new Set(evidence.memories)];

    if (messages.length + memories.length === 0) {
      throw new Error("No evidence: cite the chat messages (#rowid) or memories (#id) it rests on.");
    }

    const missing = [
      ...messages.flatMap((id) => (this.#message(id) ? [] : [`message #${id}`])),
      ...memories.flatMap((id) => (this.#count("SELECT COUNT(*) AS n FROM memo_log WHERE id = ?", id) > 0 ? [] : [`memory #${id}`]))
    ];

    if (missing.length > 0) throw new Error(`No such ${missing.join(", ")}: cite only what is there.`);

    return { messages, memories };
  }

  /**
   * Whether `id` is a user's or ky's message: chat search's rowids (src/history.ts) are pi's entry ids, read
   * from pi's entries so a message chat search has not indexed yet counts too.
   */
  #message(id: number): boolean {
    return (
      this.#count(
        "SELECT COUNT(*) AS n FROM pi_entries WHERE id = ? AND json_extract(record, '$.kind') IN ('pi.user', 'pi.assistant')",
        id
      ) > 0
    );
  }

  /** The user's latest message in `conversation`, as a message id to cite; undefined before the first. */
  latestAsk(conversation: string): number | undefined {
    const id = this.#count(
      "SELECT max(id) AS n FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user'",
      Number(conversation)
    );

    return id > 0 ? id : undefined;
  }


  #count(query: string, ...bindings: SqlStorageValue[]): number {
    return countOf(this.#sql.exec(query, ...bindings).toArray()[0]);
  }

  /** The rows still open (open or surfaced), oldest first. */
  open(): Anticipation[] {
    return this.#rows(`SELECT * FROM ky_anticipations WHERE ${LIVE} ORDER BY id`);
  }

  /**
   * For turn-start recall: open rows whose text or prepared context holds one of `terms` (case-insensitive), or
   * whose window covers `now`; the ones in their window first, then the newest. SQL only.
   */
  match(terms: readonly string[], now: number, limit = 5): Anticipation[] {
    const words = [...new Set(terms.flatMap((term) => (term.trim().length >= TERM_CHARS ? [term.trim().toLowerCase()] : [])))].slice(0, MATCH_TERMS);
    const keyword = words.map(() => "text LIKE ? ESCAPE '\\' OR prepared LIKE ? ESCAPE '\\'");

    return this.#rows(
      `SELECT * FROM ky_anticipations
       WHERE ${LIVE} AND ((window_from <= ? AND window_to >= ?)${keyword.map((each) => ` OR ${each}`).join("")})
       ORDER BY (window_from <= ? AND window_to >= ?) DESC, id DESC LIMIT ?`,
      now,
      now,
      ...words.flatMap((word) => [like(word), like(word)]),
      now,
      now,
      limit
    );
  }

  /** For the morning brief: open upcoming rows whose window meets [`now`, `until`], soonest first. */
  due(now: number, until = now + 24 * 3_600_000): Anticipation[] {
    return this.#rows(
      `SELECT * FROM ky_anticipations WHERE ${LIVE} AND kind = 'upcoming' AND window_from <= ? AND window_to >= ? ORDER BY window_from, id`,
      until,
      now
    );
  }

  /** Refused unless MOVES allows `row` to become `to`. */
  #legal(row: Anticipation, to: AnticipationStatus): void {
    if (!MOVES[row.status].includes(to)) throw new Error(`#${row.id} is ${row.status}; it cannot become ${to}.`);
  }

  /** Move `row` to `to`, with the changes that come with it; refused unless MOVES allows it. */
  #move(row: Anticipation, to: AnticipationStatus, now: number, absorbedInto: number | null = null): void {
    this.#legal(row, to);
    const closed = MOVES[to].length === 0 ? now : null;

    this.#sql.exec("UPDATE ky_anticipations SET status = ?, closed_at = ?, absorbed_into = ? WHERE id = ?", to, closed, absorbedInto, row.id);
  }

  /** The row `id`, when `by` may change it: a machine only its own kind's rows, never a pinned one. */
  #changeable(id: number, by: Actor): Anticipation {
    const row = this.get(id);

    if (by !== "user" && row.created_by === "user") throw new Error(`#${id} is the user's; only they change it.`);

    if (by !== "user" && row.pinned) throw new Error(`#${id} is pinned; only the user changes it.`);

    return row;
  }

  /**
   * Close `id` as done or dismissed. Done writes one memory with the outcome, `note` or "Done: <text>", before
   * the row closes, so a note memory refuses leaves the row open.
   */
  close(id: number, outcome: "done" | "dismissed", by: Actor, note?: string, now = Date.now()): Anticipation {
    const row = this.#changeable(id, by);

    this.#legal(row, outcome);

    if (outcome === "done") {
      const done = `Done: ${row.text}`;
      this.#memory.note(note?.trim() || (bytes(done) <= TEXT_BYTES ? done : row.text));
    }

    this.#move(row, outcome, now);

    return this.get(id);
  }

  /** Move an open row's window. */
  extend(id: number, window: Window, by: Actor): Anticipation {
    const row = this.#changeable(id, by);

    if (MOVES[row.status].length === 0) throw new Error(`#${id} is ${row.status}; only an open one moves.`);
    const { from, to } = checkWindow(window);
    this.#sql.exec("UPDATE ky_anticipations SET window_from = ?, window_to = ? WHERE id = ?", from, to, id);

    return this.get(id);
  }

  /** Fold `id` into the open row `into`, which now stands for both: `id` is dismissed, pointing at it. */
  absorb(id: number, into: number, by: Actor, now = Date.now()): Anticipation {
    const row = this.#changeable(id, by);
    const target = this.get(into);

    if (into === id || MOVES[target.status].length === 0) throw new Error(`#${into} is not another open anticipation.`);
    this.#move(row, "dismissed", now, into);

    return this.get(id);
  }

  /** Mark an open row surfaced: the brief showed it to the user. Refused unless it is open. */
  surface(id: number, now = Date.now()): Anticipation {
    const row = this.get(id);

    if (row.status !== "open") throw new Error(`#${id} is ${row.status}; only an open one is surfaced.`);
    this.#move(row, "surfaced", now);

    return this.get(id);
  }

  /** How many rows were made since `since`, and how many of those expired unseen. */
  madeSince(since: number) {
    return {
      all: this.#count("SELECT COUNT(*) AS n FROM ky_anticipations WHERE created_at >= ?", since),
      expired: this.#count("SELECT COUNT(*) AS n FROM ky_anticipations WHERE created_at >= ? AND status = 'expired'", since)
    };
  }

  /** Open rows whose window passed before `now`, never surfaced and not pinned: expired. How many. */
  expire(now = Date.now()): number {
    return this.#sql.exec(
      "UPDATE ky_anticipations SET status = 'expired', closed_at = ? WHERE status = 'open' AND pinned = 0 AND window_to < ? RETURNING id",
      now,
      now
    ).toArray().length;
  }

  /** The user keeps it: no machine changes it, and it never expires. */
  pin(id: number): void {
    this.get(id);
    this.#sql.exec("UPDATE ky_anticipations SET pinned = 1 WHERE id = ?", id);
  }

  unpin(id: number): void {
    this.get(id);
    this.#sql.exec("UPDATE ky_anticipations SET pinned = 0 WHERE id = ?", id);
  }
}

/** A row as `list` and the digest show it. */
/** A draft's text, prepared context and window, each within its limit; an upcoming one must have a window. */
function checkDraft(draft: Draft) {
  if (!ANTICIPATION_KINDS.includes(draft.kind)) throw new Error(`No kind ${draft.kind}: one of ${ANTICIPATION_KINDS.join(", ")}.`);
  const prepared = draft.prepared?.trim() || undefined;

  if (prepared !== undefined && prepared.length > PREPARED_CHARS) throw new Error(`prepared is ${prepared.length} characters, limit ${PREPARED_CHARS}.`);
  const window = draft.window === undefined ? undefined : checkWindow(draft.window);

  if (draft.kind === "upcoming" && window === undefined) throw new Error("An upcoming one needs a window: from and to.");

  return { text: checkText(draft.text), prepared, window };
}

export function anticipationLine(row: Anticipation, now: number): string {
  const days = Math.max(0, Math.floor((now - row.created_at) / 86_400_000));
  const age = days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} old`;
  const window = row.window_from === null || row.window_to === null ? "" : `, ${iso(row.window_from)} to ${iso(row.window_to)}`;
  const cites = [...row.evidence.messages.map((id) => `message #${id}`), ...row.evidence.memories.map((id) => `memory #${id}`)].join(", ");

  return `- #${row.id} ${row.kind}, ${row.status}, ${age}, by ${row.created_by}${row.pinned ? ", pinned" : ""}${window}: ${row.text} (rests on ${cites})`;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** A date the model wrote, as epoch ms; an error when it is not one. */
function when(value: string, what: string): number {
  const ms = Date.parse(value);

  if (Number.isNaN(ms)) throw new Error(`${what} "${value}" is not a date; write it like 2026-10-17T08:00:00+02:00.`);

  return ms;
}

/** The tool's window: both ends, only to (from now on), or none. */
function windowOf(from: string | undefined, to: string | undefined, now: number): Window | undefined {
  if (to === undefined) {
    if (from !== undefined) throw new Error("A window needs a to.");

    return undefined;
  }

  return { from: from === undefined ? now : when(from, "from"), to: when(to, "to") };
}

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`This action needs ${what}.`);

  return value;
};

const AnticipateInput = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("close"),
    Type.Literal("extend"),
    Type.Literal("absorb"),
    Type.Literal("pin"),
    Type.Literal("unpin"),
    Type.Literal("list"),
    Type.Literal("brief")
  ]),
  id: Type.Optional(Type.Integer({ description: "The anticipation, for close, extend, absorb, pin, unpin and brief." })),
  kind: Type.Optional(Type.Union([Type.Literal("open_loop"), Type.Literal("upcoming"), Type.Literal("predicted_ask"), Type.Literal("watch")])),
  text: Type.Optional(Type.String({ description: `One line, at most ${TEXT_BYTES} bytes.` })),
  messages: Type.Optional(Type.Array(Type.Integer(), { description: "Chat message rowids it rests on, as chat_search and the digest show them (#123)." })),
  memories: Type.Optional(Type.Array(Type.Integer(), { description: "Memory ids it rests on (#7)." })),
  prepared: Type.Optional(Type.String({ description: `Up to ${PREPARED_CHARS} characters of context a future turn would need.` })),
  from: Type.Optional(Type.String({ description: "When it starts to matter, an ISO date and time with its offset." })),
  to: Type.Optional(Type.String({ description: "When it stops mattering, an ISO date and time with its offset." })),
  outcome: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("dismissed")])),
  note: Type.Optional(Type.String({ description: "For close done: the outcome in one line, kept as a memory." })),
  into: Type.Optional(Type.Integer({ description: "For absorb: the open anticipation that now stands for this one." })),
  about: Type.Optional(Type.String({ description: "For list: only the open ones these words, or a window around now, match." })),
  hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168, description: "For list: only the dates in the next this many hours." })),
  chip: Type.Optional(Type.String({ description: "For brief: the ask a tap puts in the user's composer, ready to send." }))
});

type Call = { readonly args: Static<typeof AnticipateInput>; readonly by: Actor; readonly session: string; readonly now: number };

const lines = (rows: readonly Anticipation[], now: number) => (rows.length === 0 ? "None open." : rows.map((row) => anticipationLine(row, now)).join("\n"));

/** A brief line's ref for the evidence it cites: its first message, or else its first memory. */
const evidenceRef = (evidence: Evidence) => (evidence.messages.length > 0 ? `message:${evidence.messages[0]}` : `memory:${evidence.memories[0]}`);

/** The anticipation a brief line rests on, when it names one: refused unless open or surfaced. */
function briefAnticipation(anticipations: Anticipations, id: number | undefined): Anticipation | undefined {
  if (id === undefined) return undefined;
  const row = anticipations.get(id);

  if (MOVES[row.status].length === 0) throw new Error(`#${row.id} is ${row.status}; the brief shows only an open one.`);

  return row;
}

/** What each action does, and what it answers. */
function handlers(anticipations: Anticipations, brief: Brief): Readonly<Record<Call["args"]["action"], (call: Call) => string>> {
  const pinning = (pinned: boolean) => ({ args, by }: Call) => {
    if (by !== "user") throw new Error("Only the user pins.");
    const id = need(args.id, "id");

    if (pinned) anticipations.pin(id);
    else anticipations.unpin(id);

    return `#${id} is ${pinned ? "pinned: it never expires, and only the user changes it" : "unpinned"}.`;
  };

  return {
    add: ({ args, by, session, now }) => {
      const asked = by === "user" ? anticipations.latestAsk(session) : undefined;
      const messages = [...(args.messages ?? []), ...(asked === undefined ? [] : [asked])];

      const row = anticipations.add(
        {
          kind: need(args.kind, "kind"),
          text: need(args.text, "text"),
          evidence: { messages, memories: args.memories ?? [] },
          prepared: args.prepared,
          window: windowOf(args.from, args.to, now)
        },
        by,
        now
      );

      return `Saved as #${row.id}.`;
    },
    close: ({ args, by, now }) => {
      const id = need(args.id, "id");
      const outcome = need(args.outcome, "outcome");
      anticipations.close(id, outcome, by, args.note, now);

      return `#${id} is ${outcome}${outcome === "done" ? "; its outcome is a memory now" : ""}.`;
    },
    extend: ({ args, by, now }) => {
      const row = anticipations.extend(need(args.id, "id"), need(windowOf(args.from, args.to, now), "to"), by);

      return `#${row.id} now matters from ${iso(row.window_from ?? now)} to ${iso(row.window_to ?? now)}.`;
    },
    absorb: ({ args, by, now }) => {
      const row = anticipations.absorb(need(args.id, "id"), need(args.into, "into"), by, now);

      return `#${row.id} is folded into #${args.into}.`;
    },
    pin: pinning(true),
    unpin: pinning(false),
    list: ({ args, now }) => {
      if (args.about !== undefined) return lines(anticipations.match(args.about.split(/[^\p{L}\p{N}_]+/u), now), now);

      if (args.hours !== undefined) return lines(anticipations.due(now, now + args.hours * 3_600_000), now);

      return lines(anticipations.open(), now);
    },
    brief: ({ args, by, now }) => {
      if (by !== "dream") throw new Error("Only the dream writes the brief.");
      const row = briefAnticipation(anticipations, args.id);
      const ref = row === undefined ? evidenceRef(anticipations.checkEvidence({ messages: args.messages ?? [], memories: args.memories ?? [] })) : `anticipation:${row.id}`;
      const key = brief.append({ text: need(args.text, "text"), chip: args.chip }, { loop: "dream", ref }, now);

      if (row?.status === "open") anticipations.surface(row.id, now);

      return `In the brief as ${key}${row === undefined ? "" : `; #${row.id} is surfaced`}.`;
    }
  };
}

/**
 * The `anticipate` tool, for the dream (as `dream`) and the main chat and side chats (as `user`); memory's
 * extension carries it (src/dreaming/memory.ts), so a specialist, which may not write memory, may not call it.
 */
export function anticipateTool(anticipations: Anticipations, brief: Brief, actor: (session: string) => Actor) {
  const actions = handlers(anticipations, brief);

  return defineTool({
    name: ANTICIPATE,
    description:
      "What the user will need soon: an open loop they committed to, a date ahead, a question likely next, or something to watch. add needs kind, text (one line) and evidence: the chat messages (#rowid) or memories (#id) it rests on; from the main chat, the user's message is cited for you. prepared is the context a future turn would need. close says done (with note: the outcome, kept as a memory) or dismissed; extend moves its window; absorb folds it into another; pin keeps one for the user; list shows the open ones, about some words or the dates of the next hours. brief (the dream only) puts one line in today's brief: text, and id (an open anticipation, which becomes surfaced) or messages or memories it rests on, and chip: an ask the user can send with a tap.",
    parameters: AnticipateInput,
    replay: "unsafe",
    execute: async (args, api) => {
      const session = String(api.conversationId);

      return text(actions[args.action]({ args, by: actor(session), session, now: Date.now() }));
    }
  });
}
