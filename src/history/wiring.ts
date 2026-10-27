import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge } from "../core/edge";
import { Sql } from "../core/sql";
import type { RunInput, Said, SaidMark, SearchOptions } from "./contract";
import { Index, ownOf, PLACED, placedAround, placedOf, requestsOf } from "./history";

const WROTE_SINCE = 20;

const Id = Schema.Struct({ id: Schema.NullOr(Schema.Number) });

const idsOf = (cursor: SqlStorageCursor<Record<string, SqlStorageValue>>) => cursor.toArray().flatMap((row) => Schema.decodeUnknownSync(Id)(row).id ?? []);

export function placedBy(sql: SqlStorage, users: readonly number[]): ReadonlyMap<number, string | undefined> {
  if (users.length === 0) return new Map();

  return requestsOf(sql.exec(PLACED, ...placedAround(users)), users);
}

export function ownMessages(sql: SqlStorage, users: readonly number[]): ReadonlySet<number> {
  return ownOf(placedBy(sql, users));
}

export function startedByUser(sql: SqlStorage, conversation: string): boolean {
  const [newest] = idsOf(sql.exec("SELECT max(id) AS id FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user'", Number(conversation)));

  return newest !== undefined && ownMessages(sql, [newest]).has(newest);
}

export function runOpener(sql: SqlStorage, conversation: string, before = Number.MAX_SAFE_INTEGER): number | undefined {
  const [opener] = idsOf(
    sql.exec(
      `SELECT id FROM pi_entries WHERE conversation_id = ? AND id < ? AND json_extract(record, '$.kind') IN ('pi.user', 'pi.reset')
       ORDER BY id DESC LIMIT 1`,
      Number(conversation),
      before
    )
  );

  return opener;
}

export function runInputs(sql: SqlStorage, conversation: string): readonly RunInput[] {
  return sql
    .exec(
      `SELECT json_extract(record, '$.entry') AS entry, json_extract(record, '$.requestId') AS request FROM pi_submissions
       WHERE conversation_id = ? AND status = 'placed' ORDER BY entry`,
      Number(conversation)
    )
    .toArray()
    .flatMap((raw) => Option.toArray(Option.map(placedOf(raw), (row) => ({ entry: row.entry, request: row.request ?? undefined }))));
}

export function wroteSince(sql: SqlStorage, conversation: string, at: number): boolean {
  const users = idsOf(
    sql.exec(
      `SELECT id FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user'
       AND json_extract(record, '$.model[0].timestamp') > ? ORDER BY id DESC LIMIT ?`,
      Number(conversation),
      at,
      WROTE_SINCE
    )
  );

  return ownMessages(sql, users).size > 0;
}

export class History {
  readonly #edge: Edge<Index>;

  constructor(storage: DurableObjectStorage, isChat: (session: string) => boolean, name: (session: string) => string) {
    this.#edge = makeEdge(Index.layer({ isChat, name }).pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  search(query: string, options: SearchOptions = {}): string {
    return this.#edge.run(Index.use((index) => index.search(query, options)));
  }

  since(from: SaidMark, chars: number, now?: number): Said {
    return this.#edge.run(Index.use((index) => index.since(from, chars, now)));
  }

  latest(session: string): string | null {
    return this.#edge.run(Index.use((index) => index.latest(session)));
  }

  rebuild(): void {
    this.#edge.run(Index.use((index) => index.rebuild));
  }
}
