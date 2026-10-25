/**
 * A Durable Object's SQLite, as an Effect service: raw `ctx.storage.sql`, wrapped so a ported domain
 * reads and writes it with tagged failures and Schema-decoded rows, and stays synchronous.
 *
 * ky's storage is synchronous by design (one DO thread, input gates, `transactionSync`, listeners that
 * fire inside a write), and its callers are too, so a port runs these with `edge.run`. It does not use
 * `@effect/sql-sqlite-do`: its transactions are async and throw `AsyncFiberError` under a sync read
 * (the owner's decision from the spike, docs/migration/effect/STATUS.md). Table names never change: a
 * backup restores each by name.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** A statement SQLite refused, or a row it gave that isn't the shape asked for. */
export class SqlError extends Schema.TaggedError<SqlError>()("SqlError", { query: Schema.String, cause: Schema.Defect() }) {}

type Row = Record<string, SqlStorageValue>;

export interface SqlStatements {
  /** Runs one statement: its rows as SQLite gives them. */
  readonly exec: (query: string, ...params: SqlStorageValue[]) => Effect.Effect<ReadonlyArray<Row>, SqlError>;
  /** Runs one statement: each row decoded by `row`; a row that isn't one fails. */
  readonly rows: <T>(row: Schema.Decoder<T>, query: string, ...params: SqlStorageValue[]) => Effect.Effect<ReadonlyArray<T>, SqlError>;
  /** Runs `effect` inside `ctx.storage.transactionSync`: its failure or defect rolls back every write in it. */
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** Thrown inside `transactionSync` to make it roll back; never escapes. */
const ROLLBACK = Symbol("rollback");

export function makeSql(storage: DurableObjectStorage): SqlStatements {
  const exec = (query: string, ...params: SqlStorageValue[]) =>
    Effect.try({
      // toArray inside the try: the cursor is lazy, and a row can fail as it's read.
      try: () => storage.sql.exec(query, ...params).toArray(),
      catch: (cause) => new SqlError({ query, cause })
    });

  return {
    exec,
    rows: (row, query, ...params) =>
      Effect.flatMap(exec(query, ...params), (rows) =>
        Effect.forEach(rows, (each) => Schema.decodeUnknownEffect(row)(each).pipe(Effect.mapError((cause) => new SqlError({ query, cause }))))
      ),
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.contextWith((context: Context.Context<R>) => {
        let exit: Exit.Exit<A, E> = Exit.die(new Error("transactionSync didn't run its callback"));

        try {
          storage.transactionSync(() => {
            exit = Effect.runSyncExitWith(context)(effect);

            if (Exit.isFailure(exit)) throw ROLLBACK;
          });
        } catch (thrown) {
          if (thrown !== ROLLBACK) return Effect.die(thrown);
        }

        return exit;
      })
  };
}

export class Sql extends Context.Service<Sql, SqlStatements>()("ky/core/Sql") {
  static readonly layer = (storage: DurableObjectStorage) => Layer.succeed(Sql)(makeSql(storage));
}
