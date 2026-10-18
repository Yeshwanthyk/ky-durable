import { ROOT_SESSION } from "agents/harness/pi";
import Type from "typebox";
import { decodeOr } from "./core/decode";
import { LOOK_POST } from "./transcript";

/**
 * Chat search: a full-text index over every message of the main chat and the
 * side chats, so ky can find what was said even after compaction dropped it from
 * its context, and even if it never noted it. pi owns the transcripts, in
 * `pi_entries`; this copies their text into an FTS5 table on each search,
 * catching up from where the last one stopped. After Lossless Claw's search.
 */

/** Text kept per message; a long answer is still found by its start. */
const MESSAGE_CHARS = 4_000;
/** Matches shown per search. */

const MATCHES = 8;
/** A neighbor's text when `around` shows the messages next to a match. */

const NEIGHBOR_CHARS = 600;
/** A user's message in `since`, so one long message leaves room for the rest of the day. */

const SINCE_CHARS = 1_000;
/** ky's message or a notice in `since`: enough to say what it was about, so the user's words get the room. */

const BRIEF_CHARS = 200;
/** How far back `since` reads: older messages are left to chat_search. */

const SINCE_WINDOW_MS = 7 * 86_400_000;
/** The whole answer's cap, so a search never floods the context. */

const OUTPUT_CHARS = 12_000;
/** Entries read per batch while catching up. */

const BATCH = 500;
/**
 * pi hands out entry ids before it commits them, so a commit can land below the
 * newest id seen. Each catch-up looks back this far for such stragglers.
 */

const LOOKBACK = 256;
/**
 * How far apart, in pi's ids, a user entry and the submission that placed it may be: a direct submission is
 * made just after its entry, a queued one before it, while the run it waited behind wrote its own entries.
 */

const PLACED_SLACK = 5_000;

/** A request id the browser or the harness made up for a message the user sent: a bare UUID. ky's own relays name theirs (mail:, peer-escalate:, subagent-report:). */
const OWN_REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a submission's request id is one the browser or the harness made up for a message the user sent, not one of ky's relays. */
export function isOwnRequest(requestId: string | undefined): boolean {
  return requestId !== undefined && OWN_REQUEST.test(requestId);
}

/**
 * Who a message is from: the user, ky, or a notice, a user entry ky posted for someone else (a mail's
 * summary, a peer's question, a subagent's report, an automation's warning), never the user's own words.
 */
type Role = "user" | "ky" | "notice";

/** Where a reader of `since` stopped: pi's commit sequence, or before there was one, a time. */
export type SaidMark = { readonly seq: number; readonly at: number };

/** What `since` shows, and where the next reader starts. */
export type Said = {
  /** One line a message, oldest first. */
  readonly lines: string[];
  /** Messages it leaves to chat_search: ky's and notices that did not fit, and any older than a week. */
  readonly dropped: number;
  /** Messages after the last user's line that fit, which the next reader starts from. */
  readonly waiting: number;
  /** The commit sequence to start the next reader after. */
  readonly through: number;
};

type EntryRow = { id: number; conversation_id: number; kind: string | null; at: number; text: string | null };

/** An entry's text in SQL: a look's post, or a message's text parts, not thinking, tool calls or images; null for anything else. */
const TEXT_OF = `CASE
  WHEN json_extract(record, '$.kind') = '${LOOK_POST}' THEN json_extract(record, '$.data.text')
  WHEN json_extract(record, '$.kind') NOT IN ('pi.user', 'pi.assistant') THEN NULL
  WHEN json_type(record, '$.model[0].content') = 'text' THEN json_extract(record, '$.model[0].content')
  ELSE (SELECT group_concat(json_extract(part.value, '$.text'), char(10))
        FROM json_each(record, '$.model[0].content') AS part
        WHERE json_extract(part.value, '$.type') = 'text')
END`;

const TextRow = Type.Object({ text: Type.String() });

/** A column of `PRAGMA table_info`. */
const ColumnRow = Type.Object({ name: Type.String() });

/** Whether the index was built telling notices from the user's words. */
const RolesRow = Type.Object({ roles: Type.Number() });

/** A submission that placed a user entry, as pi keeps it; a damaged one counts as not the user's. */
const PlacedRow = Type.Object({ entry: Type.Number(), request: Type.Union([Type.String(), Type.Null()]) });

type SaidLine = { readonly seq: number; readonly user: boolean; readonly line: string };

type Hit = { rowid: number; conversation: string; role: string; at: number; snippet: string };

type Line = { rowid: number; role: string; at: number; text: string };

const CountRow = Type.Object({ n: Type.Number() });

/** A message as `since` reads it; a row a restore damaged is skipped. */
const SaidRow = Type.Object({
  rowid: Type.Number(),
  conversation: Type.String(),
  role: Type.String(),
  at: Type.Number(),
  seq: Type.Number(),
  text: Type.String()
});

/**
 * The index with each message's commit sequence, which pi keeps and the index does not: a message's entry id
 * is its rowid. One whose entry is gone has no sequence, and reads as damaged.
 */
const SAID_FROM = `(SELECT h.rowid AS rowid, h.conversation AS conversation, h.role AS role, h.at AS at, h.text AS text, e.commit_seq AS seq
  FROM ky_history AS h LEFT JOIN pi_entries AS e ON e.id = h.rowid)`;

const SeqRow = Type.Object({ seq: Type.Union([Type.Number(), Type.Null()]) });

/** A chat's newest user entry; null before the first. */
const NewestRow = Type.Object({ id: Type.Union([Type.Number(), Type.Null()]) });

export class History {
  readonly #sql: SqlStorage;
  readonly #isChat: (session: string) => boolean;
  readonly #name: (session: string) => string;

  /**
   * `isChat` says which conversations are chats (not subagents, reviews or
   * dreams); `name` names a side chat for the results.
   */
  constructor(sql: SqlStorage, isChat: (session: string) => boolean, name: (session: string) => string) {
    this.#sql = sql;
    this.#isChat = isChat;
    this.#name = name;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_history_mark (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last INTEGER NOT NULL,
      roles INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ky_history USING fts5(
      text, conversation UNINDEXED, role UNINDEXED, at UNINDEXED, tokenize = 'unicode61')`);

    if (!sql.exec("PRAGMA table_info(ky_history_mark)").toArray().some((column) => decodeOr(ColumnRow, column, undefined)?.name === "roles")) {
      sql.exec("ALTER TABLE ky_history_mark ADD COLUMN roles INTEGER NOT NULL DEFAULT 0");
    }

    const mark = decodeOr(RolesRow, sql.exec("SELECT roles FROM ky_history_mark WHERE id = 1").toArray()[0], undefined);

    // An index built before notices were told apart labelled every relay the user's: empty it, and the next
    // search builds it again from the chats.
    if (mark !== undefined && mark.roles === 0) {
      sql.exec("DELETE FROM ky_history");
      sql.exec("DELETE FROM ky_history_mark");
    }
  }

  /**
   * The best matches for `query`, each with `around` messages before and after
   * it. The user's latest message in `caller`, the chat searching, is left out:
   * it is the question, and ky has it already. `batches` caps the catch-up first: turn-start recall reads at most
   * a few, so the first turn after a deploy that emptied the index is not held up rebuilding it, and finds
   * only what is indexed so far.
   */
  search(query: string, around = 0, caller = "", batches = Number.POSITIVE_INFINITY): string {
    this.#catchUp(batches);

    const terms = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((term) => `"${term}"`);

    if (terms.length === 0) return "Give some words to search for.";

    const skip = this.#asking(caller);
    const every = this.#match(terms.join(" AND "), skip);

    if (every.length > 0 || terms.length === 1) return this.#show(every, around, "") || `No message matches ${query.trim()}.`;

    const some = this.#match(terms.join(" OR "), skip);

    return this.#show(some, around, "No message has all those words; these have some of them.\n") || `No message matches ${query.trim()}.`;
  }

  /** The user's latest message in `caller`, or -1. */
  #asking(caller: string): number {
    return (
      this.#sql
        .exec<{ rowid: number | null }>(
          "SELECT max(rowid) AS rowid FROM ky_history WHERE conversation = ? AND role = 'user'",
          caller
        )
        .toArray()[0]?.rowid ?? -1
    );
  }

  #match(expression: string, skip: number): Hit[] {
    return this.#sql
      .exec<Hit>(
        `SELECT rowid, conversation, role, at, snippet(ky_history, 0, '[', ']', ' … ', 24) AS snippet
         FROM ky_history WHERE ky_history MATCH ? AND rowid != ? ORDER BY rank LIMIT ?`,
        expression,
        skip,
        MATCHES
      )
      .toArray();
  }

  /** The hits as text, as many as fit OUTPUT_CHARS; empty when there are none. */
  #show(hits: Hit[], around: number, note: string): string {
    if (hits.length === 0) return "";

    let out = note;
    let shown = 0;

    for (const block of hits.map((hit) => this.#block(hit, around))) {
      if (out.length + block.length > OUTPUT_CHARS) break;

      out += `${block}\n\n`;
      shown++;
    }

    const more = shown < hits.length ? `, ${hits.length - shown} more cut for length` : "";

    return `${out}${shown} match${shown === 1 ? "" : "es"}${more}. Search again with other words to find more.`;
  }

  #block(hit: Hit, around: number): string {
    const head = `#${hit.rowid} ${day(hit.at)} ${this.#chatName(hit.conversation)}`;

    if (around <= 0) return `${head} ${hit.role}: ${flat(hit.snippet)}`;

    const before = this.#sql
      .exec<Line>(
        "SELECT rowid, role, at, text FROM ky_history WHERE conversation = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?",
        hit.conversation,
        hit.rowid,
        around
      )
      .toArray()
      .reverse();

    const after = this.#sql
      .exec<Line>(
        "SELECT rowid, role, at, text FROM ky_history WHERE conversation = ? AND rowid > ? ORDER BY rowid LIMIT ?",
        hit.conversation,
        hit.rowid,
        around
      )
      .toArray();

    const neighbor = (line: Line) => `  #${line.rowid} ${line.role}: ${cut(flat(line.text), NEIGHBOR_CHARS)}`;

    return [head, ...before.map(neighbor), `> #${hit.rowid} ${hit.role}: ${flat(hit.snippet)}`, ...after.map(neighbor)].join(
      "\n"
    );
  }

  /**
   * The chat messages committed after `from`, oldest first, one line each, within the last week. The user's
   * lines come first: as many as fit `chars`, each up to SINCE_CHARS; ky's and notices, each cut to
   * BRIEF_CHARS, fill what room is left among them. Messages after the last user's line that fit wait for
   * the next reader, who starts after `through`. A mark with no sequence yet reads by time.
   */
  since(from: SaidMark, chars: number, now = Date.now()): Said {
    this.#catchUp();

    const [after, bound] = from.seq > 0 ? ["seq > ?", from.seq] : ["at > ?", from.at];
    const oldest = now - SINCE_WINDOW_MS;

    const old = decodeOr(CountRow, this.#sql.exec(`SELECT count(*) AS n FROM ${SAID_FROM} WHERE ${after} AND at <= ?`, bound, oldest).one(), { n: 0 }).n;

    const rows = this.#sql.exec(
      `SELECT rowid, conversation, role, at, seq, substr(text, 1, ?) AS text FROM ${SAID_FROM} WHERE ${after} AND at > ? ORDER BY seq, rowid`,
      SINCE_CHARS + 1,
      bound,
      oldest
    );

    const said = this.#saidLines(rows);
    const { end, stopAt, shown } = fit(said, chars);

    return {
      lines: shown.map((each) => each.line),
      dropped: old + end - shown.length,
      waiting: said.length - end,
      through: stopAt === undefined ? Math.max(from.seq, this.#newestSeq()) : this.#stopBefore(stopAt, from.seq)
    };
  }

  /** Each message as the dream reads it: the user's up to SINCE_CHARS, the rest to BRIEF_CHARS. A damaged one is left out, with a warning. */
  #saidLines(rows: Iterable<unknown>): SaidLine[] {
    const said: SaidLine[] = [];
    let damaged = 0;

    for (const raw of rows) {
      const row = decodeOr(SaidRow, raw, undefined);

      if (row === undefined) {
        damaged++;
        continue;
      }

      const user = row.role === "user";
      const line = `#${row.rowid} ${day(row.at)} ${this.#chatName(row.conversation)}, ${row.role}: ${cut(flat(row.text), user ? SINCE_CHARS : BRIEF_CHARS)}`;
      said.push({ seq: row.seq, user, line });
    }

    if (damaged > 0) console.warn(`chat search: ${damaged} damaged messages left out of what the dream reads`);

    return said;
  }

  /**
   * The sequence to stop at before a message of sequence `seq` that did not fit. A commit can hold more than one
   * message, so those of `seq` that were shown are read again; unless that would read nothing new, when the rest
   * of `seq` is left to chat_search instead.
   */
  #stopBefore(seq: number, from: number): number {
    return seq - 1 > from ? seq - 1 : seq;
  }

  /** The newest indexed message's commit sequence; 0 with none. */
  #newestSeq(): number {
    return decodeOr(SeqRow, this.#sql.exec(`SELECT max(seq) AS seq FROM ${SAID_FROM}`).one(), { seq: null }).seq ?? 0;
  }

  #chatName(conversation: string): string {
    return conversation === ROOT_SESSION ? "main chat" : `chat "${this.#name(conversation)}"`;
  }

  /**
   * ky's latest message in `session` that has text, a finished answer or a look's post; null before the first.
   * A step that goes on to call a tool, or an answer cut off by a stop or a failure, is not one.
   */
  latest(session: string): string | null {
    const row = this.#sql
      .exec(
        `SELECT text FROM (SELECT id, ${TEXT_OF} AS text FROM pi_entries
           WHERE conversation_id = ? AND (json_extract(record, '$.kind') = '${LOOK_POST}'
             OR (json_extract(record, '$.kind') = 'pi.assistant' AND json_extract(record, '$.model[0].stopReason') IN ('stop', 'length'))))
         WHERE trim(coalesce(text, '')) != '' ORDER BY id DESC LIMIT 1`,
        Number(session)
      )
      .toArray()[0];

    return decodeOr(TextRow, row, undefined)?.text ?? null;
  }

  /** Index every chat message again, as after a restore replaced the transcripts. */
  rebuild(): void {
    this.#sql.exec("DELETE FROM ky_history");
    this.#sql.exec("DELETE FROM ky_history_mark");
    this.#catchUp();
  }

  /** Copy the chat messages pi committed since the last search, at most `batches` batches of them. */
  #catchUp(batches = Number.POSITIVE_INFINITY): void {
    let last = this.#sql.exec<{ last: number }>("SELECT last FROM ky_history_mark").toArray()[0]?.last ?? 0;
    let from = Math.max(0, last - LOOKBACK);

    for (let read = 0; read < batches; read++) {
      const rows = this.#entries(from);

      if (rows.length === 0) break;
      const own = this.#own(rows);

      for (const row of rows) this.#index(row, own);

      from = rows.at(-1)!.id;
      last = Math.max(last, from);
    }

    this.#sql.exec("INSERT OR REPLACE INTO ky_history_mark (id, last, roles) VALUES (1, ?, 1)", last);
  }

  /** The next batch of pi's entries after `from`, as text; null text for anything but a user's or ky's message. */
  #entries(from: number): EntryRow[] {
    return this.#sql
      .exec<EntryRow>(
        `SELECT id, conversation_id, json_extract(record, '$.kind') AS kind,
           coalesce(json_extract(record, '$.model[0].timestamp'), 0) AS at, ${TEXT_OF} AS text
         FROM pi_entries WHERE id > ? ORDER BY id LIMIT ?`,
        from,
        BATCH
      )
      .toArray();
  }

  /** Of these entries, the user entries the user sent; every other user entry is a notice. */
  #own(rows: readonly EntryRow[]): ReadonlySet<number> {
    return ownMessages(
      this.#sql,
      rows.flatMap((row) => (row.kind === "pi.user" ? [row.id] : []))
    );
  }

  /** Index one entry, if it is a chat's message with text, and is not indexed yet. */
  #index(row: EntryRow, own: ReadonlySet<number>): void {
    const conversation = String(row.conversation_id);
    const text = (row.text ?? "").slice(0, MESSAGE_CHARS);

    if (text.trim() === "" || !this.#isChat(conversation)) return;

    this.#sql.exec(
      "INSERT OR IGNORE INTO ky_history (rowid, text, conversation, role, at) VALUES (?, ?, ?, ?, ?)",
      row.id,
      text,
      conversation,
      roleOf(row, own),
      row.at
    );
  }
}

/**
 * What of `said` fits `chars`: the user's lines, oldest first, up to the first that does not fit (`end`, at
 * commit `stopAt`), where this reading ends; then ky's and notices before `end` while room is left.
 */
function fit(said: readonly SaidLine[], chars: number) {
  let used = 0;
  let end = said.length;
  let stopAt: number | undefined;

  for (const [index, each] of said.entries()) {
    if (!each.user) continue;

    if (used + each.line.length + 1 > chars) {
      end = index;
      stopAt = each.seq;
      break;
    }

    used += each.line.length + 1;
  }

  const shown = said.slice(0, end).filter((each) => {
    if (each.user) return true;

    if (used + each.line.length + 1 > chars) return false;
    used += each.line.length + 1;

    return true;
  });

  return { end, stopAt, shown };
}

/** A user entry is the user's own only if they sent it; anything else ky wrote. */
function roleOf(row: EntryRow, own: ReadonlySet<number>): Role {
  if (row.kind !== "pi.user") return "ky";

  return own.has(row.id) ? "user" : "notice";
}

/**
 * Of the user entries `users` (pi's entry ids), the ones the user sent: placed by a submission whose request id the
 * browser or the harness made up, a bare UUID. Every other user entry is a notice ky posted for someone else (a mail's
 * summary, a peer's question, a subagent's report), never the user's own words. Chat search labels by it, and an
 * episode reflection (src/dreaming/episodes.ts) counts only these as the user's turns.
 */
export function ownMessages(sql: SqlStorage, users: readonly number[]): ReadonlySet<number> {
  return new Set([...placedBy(sql, users)].flatMap(([entry, request]) => (isOwnRequest(request) ? [entry] : [])));
}

/** Of the user entries `users` (pi's entry ids), the request id of the submission that placed each; one placed by none is left out. */
export function placedBy(sql: SqlStorage, users: readonly number[]): ReadonlyMap<number, string | undefined> {
  if (users.length === 0) return new Map();

  const low = Math.min(...users);
  const high = Math.max(...users);
  const wanted = new Set(users);

  const placed = sql.exec(
    `SELECT json_extract(record, '$.entry') AS entry, json_extract(record, '$.requestId') AS request FROM pi_submissions
     WHERE id BETWEEN ? AND ? AND json_extract(record, '$.entry') BETWEEN ? AND ?`,
    low - PLACED_SLACK,
    high + PLACED_SLACK,
    low,
    high
  );

  const requests = new Map<number, string | undefined>();

  for (const raw of placed) {
    const row = decodeOr(PlacedRow, raw, undefined);

    if (row !== undefined && wanted.has(row.entry)) requests.set(row.entry, row.request ?? undefined);
  }

  return requests;
}

/**
 * Whether the chat's newest user entry is one the user sent. A turn runs for its newest user entry, so this tells
 * a turn the user started from one a notice started (a relayed mail, a peer's question, a report), whose model must
 * not act as the user.
 */
export function startedByUser(sql: SqlStorage, conversation: string): boolean {
  const newest = decodeOr(
    NewestRow,
    sql.exec("SELECT max(id) AS id FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user'", Number(conversation)).one(),
    { id: null }
  ).id;

  return newest !== null && ownMessages(sql, [newest]).has(newest);
}

/**
 * The request ids that placed the user entries of the chat's running turn, oldest first: those since ky's last
 * finished answer (one that did not go on to call a tool). A report steered in mid-turn is one of them; one no
 * request placed is undefined.
 */
export function turnPlacedBy(sql: SqlStorage, conversation: string): Array<string | undefined> {
  const users = sql
    .exec(
      `SELECT id FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user'
       AND id > (SELECT coalesce(max(id), 0) FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.assistant'
                 AND coalesce(json_extract(record, '$.model[0].stopReason'), '') != 'toolUse')
       ORDER BY id`,
      Number(conversation),
      Number(conversation)
    )
    .toArray()
    .flatMap((row) => decodeOr(NewestRow, row, undefined)?.id ?? []);

  const placed = placedBy(sql, users);

  return users.map((id) => placed.get(id));
}

/** User entries of a chat read for whether the user wrote since: notices placed since are passed over. */
const WROTE_SINCE = 20;

/** Whether the user sent a message in `conversation` after `at`, epoch ms, among its newest WROTE_SINCE user entries. */
export function wroteSince(sql: SqlStorage, conversation: string, at: number): boolean {
  const users = sql
    .exec(
      `SELECT id FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user'
       AND json_extract(record, '$.model[0].timestamp') > ? ORDER BY id DESC LIMIT ?`,
      Number(conversation),
      at,
      WROTE_SINCE
    )
    .toArray()
    .flatMap((row) => decodeOr(NewestRow, row, undefined)?.id ?? []);

  return ownMessages(sql, users).size > 0;
}

const day = (at: number) => (at > 0 ? new Date(at).toISOString().slice(0, 10) : "----------");

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);
