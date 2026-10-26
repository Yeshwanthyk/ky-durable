import { ROOT_SESSION } from "agents/harness/pi";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Sql } from "../core/sql";
import { LOOK_POST } from "../core/transcript";
import { HISTORY_TABLES, isOwnRequest, type Said, type SaidMark, type SearchOptions, type Span } from "./contract";

const INDEX = HISTORY_TABLES.index;

const MARK = HISTORY_TABLES.mark;

const MESSAGE_CHARS = 4_000;

const MATCHES = 8;

const NEIGHBOR_CHARS = 600;

const SINCE_CHARS = 1_000;

const BRIEF_CHARS = 200;

const SINCE_WINDOW_MS = 7 * 86_400_000;

const OUTPUT_CHARS = 12_000;

const BATCH = 500;

const LOOKBACK = 256;

const PLACED_SLACK = 5_000;

const ALWAYS = { from: Number.MIN_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER };

const TEXT_OF = `CASE
  WHEN json_extract(record, '$.kind') = '${LOOK_POST}' THEN json_extract(record, '$.data.text')
  WHEN json_extract(record, '$.kind') NOT IN ('pi.user', 'pi.assistant') THEN NULL
  WHEN json_type(record, '$.model[0].content') = 'text' THEN json_extract(record, '$.model[0].content')
  ELSE (SELECT group_concat(json_extract(part.value, '$.text'), char(10))
        FROM json_each(record, '$.model[0].content') AS part
        WHERE json_extract(part.value, '$.type') = 'text')
END`;

const SAID_FROM = `(SELECT h.rowid AS rowid, h.conversation AS conversation, h.role AS role, h.at AS at, h.text AS text, e.commit_seq AS seq
  FROM ${INDEX} AS h LEFT JOIN pi_entries AS e ON e.id = h.rowid)`;

const IndexRow = Schema.Struct({
  rowid: Schema.Number,
  text: Schema.String,
  conversation: Schema.String,
  role: Schema.Literals(["user", "ky", "notice"]),
  at: Schema.Union([Schema.Number, Schema.String])
});

const MarkRow = Schema.Struct({ id: Schema.Number, last: Schema.Number, roles: Schema.Number });

const Entry = Schema.Struct({
  id: Schema.Number,
  conversation_id: Schema.Number,
  kind: Schema.NullOr(Schema.String),
  at: IndexRow.fields.at,
  text: Schema.NullOr(Schema.String)
});

type Entry = typeof Entry.Type;

const Hit = IndexRow.mapFields((fields) => ({ ...Struct.pick(fields, ["rowid", "conversation", "role"]), at: Schema.Number, snippet: Schema.String }));

type Hit = typeof Hit.Type;

const Line = IndexRow.mapFields(Struct.pick(["rowid", "role", "text"]));

type Line = typeof Line.Type;

const SaidRow = IndexRow.mapFields((fields) => ({ ...Struct.pick(fields, ["rowid", "conversation", "role", "text"]), at: Schema.Number, seq: Schema.Number }));

const Last = MarkRow.mapFields(Struct.pick(["last"]));

const Roles = MarkRow.mapFields(Struct.pick(["roles"]));

const Placed = Schema.Struct({ entry: Schema.Number, request: Schema.NullOr(Schema.String) });

const Column = Schema.Struct({ name: Schema.String });

const Text = Schema.Struct({ text: Schema.NullOr(Schema.String) });

const Count = Schema.Struct({ n: Schema.Number });

const Newest = Schema.Struct({ seq: Schema.NullOr(Schema.Number) });

const Asking = Schema.Struct({ rowid: Schema.NullOr(Schema.Number) });

export const placedOf = Schema.decodeUnknownOption(Placed);

const saidOf = Schema.decodeUnknownOption(SaidRow);

export const PLACED = `SELECT json_extract(record, '$.entry') AS entry, json_extract(record, '$.requestId') AS request FROM pi_submissions
     WHERE id BETWEEN ? AND ? AND json_extract(record, '$.entry') BETWEEN ? AND ?`;

export const placedAround = (users: readonly number[]) => {
  const low = Math.min(...users);
  const high = Math.max(...users);

  return [low - PLACED_SLACK, high + PLACED_SLACK, low, high];
};

export function requestsOf(placed: Iterable<unknown>, users: readonly number[]): ReadonlyMap<number, string | undefined> {
  const wanted = new Set(users);
  const requests = new Map<number, string | undefined>();

  for (const raw of placed) {
    const row = placedOf(raw);

    if (Option.isSome(row) && wanted.has(row.value.entry)) requests.set(row.value.entry, row.value.request ?? undefined);
  }

  return requests;
}

export const ownOf = (requests: ReadonlyMap<number, string | undefined>): ReadonlySet<number> =>
  new Set([...requests].flatMap(([entry, request]) => (isOwnRequest(request) ? [entry] : [])));

type SaidLine = { readonly seq: number; readonly user: boolean; readonly line: string };

const termsOf = (query: string) => (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((term) => `"${term}"`);

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

const roleOf = (row: Entry, own: ReadonlySet<number>) => (row.kind !== "pi.user" ? "ky" : own.has(row.id) ? "user" : "notice");

const day = (at: number) => (at > 0 ? new Date(at).toISOString().slice(0, 10) : "----------");

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

type IndexDeps = {
  readonly isChat: (session: string) => boolean;
  readonly name: (session: string) => string;
};

interface ChatSearch {
  readonly search: (query: string, options: SearchOptions) => Effect.Effect<string>;
  readonly since: (from: SaidMark, chars: number, now: number | undefined) => Effect.Effect<Said>;
  readonly latest: (session: string) => Effect.Effect<string | null>;
  readonly rebuild: Effect.Effect<void>;
}

export class Index extends Context.Service<Index, ChatSearch>()("ky/history/Index") {
  static readonly layer = (deps: IndexDeps) =>
    Layer.effect(
      Index,
      Effect.gen(function* () {
        const sql = yield* Sql;
        const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
        const rows = <T>(row: Schema.Decoder<T>, query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.rows(row, query, ...params));

        yield* exec(`CREATE TABLE IF NOT EXISTS ${MARK} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last INTEGER NOT NULL,
      roles INTEGER NOT NULL DEFAULT 0)`);
        yield* exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${INDEX} USING fts5(
      text, conversation UNINDEXED, role UNINDEXED, at UNINDEXED, tokenize = 'unicode61')`);

        const columns = yield* rows(Column, `PRAGMA table_info(${MARK})`);

        if (!columns.some((column) => column.name === "roles")) {
          yield* exec(`ALTER TABLE ${MARK} ADD COLUMN roles INTEGER NOT NULL DEFAULT 0`);
        }

        const [marked] = yield* rows(Roles, `SELECT roles FROM ${MARK} WHERE id = 1`);

        if (marked?.roles === 0) {
          yield* exec(`DELETE FROM ${INDEX}`);
          yield* exec(`DELETE FROM ${MARK}`);
        }

        const chatName = (conversation: string) => (conversation === ROOT_SESSION ? "main chat" : `chat "${deps.name(conversation)}"`);

        const own = (entries: readonly Entry[]) =>
          Effect.gen(function* () {
            const users = entries.flatMap((row) => (row.kind === "pi.user" ? [row.id] : []));

            if (users.length === 0) return new Set<number>();

            return ownOf(requestsOf(yield* exec(PLACED, ...placedAround(users)), users));
          });

        const index = (row: Entry, mine: ReadonlySet<number>) => {
          const conversation = String(row.conversation_id);
          const text = (row.text ?? "").slice(0, MESSAGE_CHARS);

          if (text.trim() === "" || !deps.isChat(conversation)) return Effect.void;

          return exec(
            `INSERT OR IGNORE INTO ${INDEX} (rowid, text, conversation, role, at) VALUES (?, ?, ?, ?, ?)`,
            row.id,
            text,
            conversation,
            roleOf(row, mine),
            row.at
          );
        };

        const catchUp = (batches: number) =>
          Effect.gen(function* () {
            const [mark] = yield* rows(Last, `SELECT last FROM ${MARK}`);
            let last = mark?.last ?? 0;
            let from = Math.max(0, last - LOOKBACK);

            for (let read = 0; read < batches; read++) {
              const entries = yield* rows(
                Entry,
                `SELECT id, conversation_id, json_extract(record, '$.kind') AS kind,
           coalesce(json_extract(record, '$.model[0].timestamp'), 0) AS at, ${TEXT_OF} AS text
         FROM pi_entries WHERE id > ? ORDER BY id LIMIT ?`,
                from,
                BATCH
              );

              const newest = entries.at(-1);

              if (newest === undefined) break;
              const mine = yield* own(entries);

              for (const row of entries) yield* index(row, mine);

              from = newest.id;
              last = Math.max(last, from);
            }

            yield* exec(`INSERT OR REPLACE INTO ${MARK} (id, last, roles) VALUES (1, ?, 1)`, last);
          });

        const match = (expression: string, skip: number, span: Pick<Span, "from" | "to">) =>
          rows(
            Hit,
            `SELECT rowid, conversation, role, at, snippet(${INDEX}, 0, '[', ']', ' … ', 24) AS snippet
         FROM ${INDEX} WHERE ${INDEX} MATCH ? AND rowid != ? AND at >= ? AND at < ? ORDER BY rank LIMIT ?`,
            expression,
            skip,
            span.from,
            span.to,
            MATCHES
          );

        const block = (hit: Hit, around: number) =>
          Effect.gen(function* () {
            const head = `#${hit.rowid} ${day(hit.at)} ${chatName(hit.conversation)}`;

            if (around <= 0) return `${head} ${hit.role}: ${flat(hit.snippet)}`;

            const before = yield* rows(
              Line,
              `SELECT rowid, role, at, text FROM ${INDEX} WHERE conversation = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
              hit.conversation,
              hit.rowid,
              around
            );

            const after = yield* rows(
              Line,
              `SELECT rowid, role, at, text FROM ${INDEX} WHERE conversation = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
              hit.conversation,
              hit.rowid,
              around
            );

            const neighbor = (line: Line) => `  #${line.rowid} ${line.role}: ${cut(flat(line.text), NEIGHBOR_CHARS)}`;

            return [head, ...[...before].reverse().map(neighbor), `> #${hit.rowid} ${hit.role}: ${flat(hit.snippet)}`, ...after.map(neighbor)].join("\n");
          });

        const show = (hits: readonly Hit[], around: number, note: string) =>
          Effect.gen(function* () {
            if (hits.length === 0) return "";

            let out = note;
            let shown = 0;

            for (const hit of hits) {
              const each = yield* block(hit, around);

              if (out.length + each.length > OUTPUT_CHARS) break;

              out += `${each}\n\n`;
              shown++;
            }

            const more = shown < hits.length ? `, ${hits.length - shown} more cut for length` : "";

            return `${out}${shown} match${shown === 1 ? "" : "es"}${more}. Search again with other words to find more.`;
          });

        const said = (raw: Iterable<unknown>) =>
          Effect.gen(function* () {
            const lines: SaidLine[] = [];
            let damaged = 0;

            for (const each of raw) {
              const row = saidOf(each);

              if (Option.isNone(row)) {
                damaged++;
                continue;
              }

              const { rowid, conversation, role, at, text } = row.value;
              const user = role === "user";
              lines.push({ seq: row.value.seq, user, line: `#${rowid} ${day(at)} ${chatName(conversation)}, ${role}: ${cut(flat(text), user ? SINCE_CHARS : BRIEF_CHARS)}` });
            }

            if (damaged > 0) yield* Console.warn(`chat search: ${damaged} damaged messages left out of what the dream reads`);

            return lines;
          });

        const asking = (caller: string) =>
          Effect.map(
            rows(Asking, `SELECT max(rowid) AS rowid FROM ${INDEX} WHERE conversation = ? AND role = 'user'`, caller),
            ([row]) => row?.rowid ?? -1
          );

        return Index.of({
          search: (query, { around = 0, caller = "", batches = Number.POSITIVE_INFINITY, span }) =>
            Effect.gen(function* () {
              yield* catchUp(batches);

              const terms = termsOf(query);

              if (terms.length === 0) return "Give some words to search for.";

              const skip = yield* asking(caller);
              const during = span === undefined ? "" : ` ${span.days}`;
              const none = `No message matches ${query.trim()}${during}.`;
              const window = span ?? ALWAYS;
              const every = yield* match(terms.join(" AND "), skip, window);

              if (every.length > 0 || terms.length === 1) return (yield* show(every, around, "")) || none;

              const some = yield* match(terms.join(" OR "), skip, window);

              return (yield* show(some, around, `No message has all those words${during}; these have some of them.\n`)) || none;
            }),
          since: (from, chars, at) =>
            Effect.gen(function* () {
              yield* catchUp(Number.POSITIVE_INFINITY);

              const now = at ?? (yield* Clock.currentTimeMillis);
              const [after, bound] = from.seq > 0 ? ["seq > ?", from.seq] : ["at > ?", from.at];
              const oldest = now - SINCE_WINDOW_MS;
              const [{ n: old } = { n: 0 }] = yield* rows(Count, `SELECT count(*) AS n FROM ${SAID_FROM} WHERE ${after} AND at <= ?`, bound, oldest);

              const lines = yield* said(
                yield* exec(
                  `SELECT rowid, conversation, role, at, seq, substr(text, 1, ?) AS text FROM ${SAID_FROM} WHERE ${after} AND at > ? ORDER BY seq, rowid`,
                  SINCE_CHARS + 1,
                  bound,
                  oldest
                )
              );

              const { end, stopAt, shown } = fit(lines, chars);
              const [newest] = yield* rows(Newest, `SELECT max(seq) AS seq FROM ${SAID_FROM}`);
              const stopBefore = (seq: number) => (seq - 1 > from.seq ? seq - 1 : seq);

              return {
                lines: shown.map((each) => each.line),
                dropped: old + end - shown.length,
                waiting: lines.length - end,
                through: stopAt === undefined ? Math.max(from.seq, newest?.seq ?? 0) : stopBefore(stopAt)
              };
            }),
          latest: (session) =>
            Effect.map(
              rows(
                Text,
                `SELECT CASE WHEN typeof(text) = 'text' THEN text END AS text FROM (SELECT id, ${TEXT_OF} AS text FROM pi_entries
           WHERE conversation_id = ? AND (json_extract(record, '$.kind') = '${LOOK_POST}'
             OR (json_extract(record, '$.kind') = 'pi.assistant' AND json_extract(record, '$.model[0].stopReason') IN ('stop', 'length'))))
         WHERE trim(coalesce(text, '')) != '' ORDER BY id DESC LIMIT 1`,
                Number(session)
              ),
              ([row]) => row?.text ?? null
            ),
          rebuild: Effect.gen(function* () {
            yield* exec(`DELETE FROM ${INDEX}`);
            yield* exec(`DELETE FROM ${MARK}`);
            yield* catchUp(Number.POSITIVE_INFINITY);
          })
        });
      })
    );
}
