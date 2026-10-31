import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge } from "../core/edge";
import { Sql } from "../core/sql";
import { OUTSIDE_TABLES, OutsideSource } from "./contract";

const TABLE = OUTSIDE_TABLES.marks;

const Row = Schema.Struct({ conversation: Schema.String, source: OutsideSource, at: Schema.Number });

type Row = typeof Row.Type;

const rowOf = Schema.decodeUnknownOption(Row);

/**
 * Which conversations took in outside content, and from what. A mark stays: what was read stays in what the model
 * sees, so a write the conversation asks for after it waits for the user's OK (src/approvals/executor.ts verdict).
 */
export class OutsideContent extends Context.Service<
  OutsideContent,
  {
    mark(conversation: string, source: OutsideSource): Effect.Effect<void>;
    marked(conversation: string): Effect.Effect<ReadonlyArray<Row>>;
    /** `to` takes each mark `from` has: what one conversation tells another carries what led to it. */
    carry(from: string, to: string): Effect.Effect<void>;
  }
>()("ky/outside/OutsideContent") {
  static readonly layer = Layer.effect(
    OutsideContent,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));

      yield* exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (conversation TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (conversation, source))`);

      return OutsideContent.of({
        mark: Effect.fnUntraced(function* (conversation, source) {
          const now = yield* Clock.currentTimeMillis;
          yield* exec(`INSERT OR IGNORE INTO ${TABLE} (conversation, source, at) VALUES (?, ?, ?)`, conversation, source, now);
        }),
        marked: (conversation) =>
          Effect.map(exec(`SELECT conversation, source, at FROM ${TABLE} WHERE conversation = ? ORDER BY at, source`, conversation), (rows) =>
            rows.flatMap((row) => Option.toArray(rowOf(row)))
          ),
        carry: (from, to) =>
          Effect.asVoid(exec(`INSERT OR IGNORE INTO ${TABLE} (conversation, source, at) SELECT ?, source, at FROM ${TABLE} WHERE conversation = ?`, to, from))
      });
    })
  );
}

/** The marks for code that isn't Effect: the agent, when one conversation's words reach another. */
export class Outside {
  readonly #edge: Edge<OutsideContent>;

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(OutsideContent.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  mark(conversation: string, source: OutsideSource): void {
    this.#edge.run(OutsideContent.use((outside) => outside.mark(conversation, source)));
  }

  carry(from: string, to: string): void {
    this.#edge.run(OutsideContent.use((outside) => outside.carry(from, to)));
  }
}
