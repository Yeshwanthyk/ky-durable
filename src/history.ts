import { ROOT_SESSION } from "agents/harness/pi";
import Type from "typebox";
import { decodeOr } from "./core/decode";

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
/** A message's text in `since`, so one long answer leaves room for the rest of the day. */

const SINCE_CHARS = 1_000;
/** The whole answer's cap, so a search never floods the context. */

const OUTPUT_CHARS = 12_000;
/** Entries read per batch while catching up. */

const BATCH = 500;
/**
 * pi hands out entry ids before it commits them, so a commit can land below the
 * newest id seen. Each catch-up looks back this far for such stragglers.
 */

const LOOKBACK = 256;

type EntryRow = { id: number; conversation_id: number; kind: string | null; at: number; text: string | null };

type Hit = { rowid: number; conversation: string; role: string; at: number; snippet: string };

type Line = { rowid: number; role: string; at: number; text: string };

const CountRow = Type.Object({ n: Type.Number() });

/** A message as `since` reads it; a row a restore damaged is skipped. */
const SaidRow = Type.Object({ rowid: Type.Number(), conversation: Type.String(), role: Type.String(), at: Type.Number(), text: Type.String() });

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
    sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ky_history USING fts5(
      text, conversation UNINDEXED, role UNINDEXED, at UNINDEXED, tokenize = 'unicode61')`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_history_mark (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last INTEGER NOT NULL)`);
  }

  /**
   * The best matches for `query`, each with `around` messages before and after
   * it. The user's latest message in `caller`, the chat searching, is left out:
   * it is the question, and ky has it already.
   */
  search(query: string, around = 0, caller = ""): string {
    this.#catchUp();

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
   * The chat messages said after `at`, oldest first, one line each, as many of
   * the newest as fit `chars`; `left` counts the older ones that did not fit.
   */
  since(at: number, chars: number) {
    this.#catchUp();

    const total = decodeOr(CountRow, this.#sql.exec("SELECT count(*) AS n FROM ky_history WHERE at > ?", at).one(), { n: 0 }).n;
    // A cursor reads lazily, so a first dream over the whole history stops reading at the cap.
    const rows = this.#sql.exec("SELECT rowid, conversation, role, at, text FROM ky_history WHERE at > ? ORDER BY rowid DESC", at);

    const lines: string[] = [];

    let used = 0;

    for (const raw of rows) {
      const row = decodeOr(SaidRow, raw, undefined);

      if (row === undefined) continue;

      const line = `#${row.rowid} ${day(row.at)} ${this.#chatName(row.conversation)}, ${row.role}: ${cut(flat(row.text), SINCE_CHARS)}`;

      if (used + line.length > chars) break;

      lines.push(line);
      used += line.length + 1;
    }

    return { lines: lines.reverse(), left: total - lines.length };
  }

  #chatName(conversation: string): string {
    return conversation === ROOT_SESSION ? "main chat" : `chat "${this.#name(conversation)}"`;
  }

  /** Index every chat message again, as after a restore replaced the transcripts. */
  rebuild(): void {
    this.#sql.exec("DELETE FROM ky_history");
    this.#sql.exec("DELETE FROM ky_history_mark");
    this.#catchUp();
  }

  /** Copy the chat messages pi committed since the last search. */
  #catchUp(): void {
    let last = this.#sql.exec<{ last: number }>("SELECT last FROM ky_history_mark").toArray()[0]?.last ?? 0;
    let from = Math.max(0, last - LOOKBACK);

    for (let rows = this.#entries(from); rows.length > 0; rows = this.#entries(from)) {
      for (const row of rows) this.#index(row);

      from = rows.at(-1)!.id;
      last = Math.max(last, from);
    }

    this.#sql.exec("INSERT OR REPLACE INTO ky_history_mark (id, last) VALUES (1, ?)", last);
  }

  /** The next batch of pi's entries after `from`, as text; null text for anything but a user's or ky's message. */
  #entries(from: number): EntryRow[] {
    return this.#sql
      .exec<EntryRow>(
        // A message's content is a string or a list of parts; only text parts are kept, not thinking, tool calls or images.
        `SELECT id, conversation_id, json_extract(record, '$.kind') AS kind,
           coalesce(json_extract(record, '$.model[0].timestamp'), 0) AS at,
           CASE
             WHEN json_extract(record, '$.kind') NOT IN ('pi.user', 'pi.assistant') THEN NULL
             WHEN json_type(record, '$.model[0].content') = 'text' THEN json_extract(record, '$.model[0].content')
             ELSE (SELECT group_concat(json_extract(part.value, '$.text'), char(10))
                   FROM json_each(record, '$.model[0].content') AS part
                   WHERE json_extract(part.value, '$.type') = 'text')
           END AS text
         FROM pi_entries WHERE id > ? ORDER BY id LIMIT ?`,
        from,
        BATCH
      )
      .toArray();
  }

  /** Index one entry, if it is a chat's message with text, and is not indexed yet. */
  #index(row: EntryRow): void {
    const conversation = String(row.conversation_id);
    const text = (row.text ?? "").slice(0, MESSAGE_CHARS);

    if (text.trim() === "" || !this.#isChat(conversation)) return;

    this.#sql.exec(
      "INSERT OR IGNORE INTO ky_history (rowid, text, conversation, role, at) VALUES (?, ?, ?, ?, ?)",
      row.id,
      text,
      conversation,
      row.kind === "pi.user" ? "user" : "ky",
      row.at
    );
  }
}

const day = (at: number) => (at > 0 ? new Date(at).toISOString().slice(0, 10) : "----------");

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);
