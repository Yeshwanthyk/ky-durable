---
name: effect-do-storage
description: Moves a ky domain's Durable Object SQLite reads and writes onto the sync-first `Sql` Effect service over raw `ctx.storage.sql` (`Effect.try`, a tagged `SqlError`, a `transactionSync` helper, Schema-decoded rows), keeping table names and sync callers. Use when ported code touches `ctx.storage.sql`, `sql.exec`, `transactionSync`, a domain's tables or `ky_restore__<table>`, or when someone proposes `@effect/sql-sqlite-do`.
---

# DO storage in an Effect port

ky's storage is **synchronous** by design: one Durable Object thread, input gates, `transactionSync`, listeners that fire inside a write (`onChange`, `#emit`). A port keeps it that way. It wraps raw `ctx.storage.sql` in a small `Sql` service and runs it with `edge.run`. It does not use `@effect/sql-sqlite-do`.

Why (the owner's decision, from the spike on branch `spike/effect-do-storage`, `docs/spike/effect-do-storage.md`): `sqlite-do`'s `withTransaction` is the async `storage.transaction()` behind a semaphore. A sync read from a fresh `runSync` while one is open throws `AsyncFiberError` at run time, the type checker can't see it, and ky has 464 sync `exec` call sites. It also costs about +43 KB gzip and +4–5 ms boot over a plain Effect wrapper. **Revisit `sqlite-do` only once a domain has no sync callers left**; `SqliteClient.layer({ storage })` then drops in over the same `ctx.storage` and table names.

## The service

```ts
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
```

It is built from `DurableObjectStorage`, not `SqlStorage`, because `transactionSync` lives on the storage. The domain's edge provides it: `makeEdge(Domain.layer.pipe(Layer.provide(Sql.layer(ctx.storage))))` (see `modeling-effect-domain`).

## Rules

- **Table names never change**, nor the `CREATE TABLE` text's columns. A backup restores each table by name, staged as `ky_restore__<table>` (`src/backup.ts:217`), and the restore runs under one raw `transactionSync` (`src/backup.ts:536`). Stored data at B must load: take names from the contract's `<DOMAIN>_TABLES` (`AUTOMATION_TABLES`, `SKILL_TABLES`) and keep the `CREATE TABLE IF NOT EXISTS` and `addColumns` migrations as B wrote them.
- **Everything under `Sql` is synchronous.** No `Effect.promise`, `sleep` or fetch between a read and the write it guards. `edge.run` throws on an Effect that waits, and inside `transaction` a wait is a defect that rolls back. Work that waits (booking an alarm, a fetch) happens after the transaction, as B's `#bookZone` runs after `#keepZone`.
- **A `SqlError` is a defect** unless the domain has a real recovery for it: `Effect.orDie` at the domain's storage calls, which is what a throwing `exec` was at B.
- **Rows are decoded, with B's fallback.** Use `rows` when a bad row is an error, and `Schema.decodeUnknownOption` with B's fallback where B used `decodeOr` on a stored row (see `decoding-effect-boundaries`).
- **Sync callers keep sync methods.** The wiring facade calls `edge.run`, so `checkIns()` and its 8 sync callers don't change.

## A domain's use

`transaction` is for writes that must land together or not at all: where B called `transactionSync`, or where a port adds that guarantee on purpose (B ran `#logStep`'s two statements bare; wrapping them is a choice the port declares).

```ts
const CHECK_INS = "ky_check_ins";

const StoredCheckIns = Schema.Struct({ off: Schema.Number, zone: Schema.NullOr(Schema.String), zone_pinned: Schema.Number });

export const checkIns = Effect.gen(function* () {
  const sql = yield* Sql;
  const [row] = yield* sql.exec(`SELECT off, zone, zone_pinned FROM ${CHECK_INS} WHERE id = 1`);
  // B's decodeOr(StoredCheckIns, row, undefined): a damaged row reads as no row.
  const stored = Option.getOrUndefined(Schema.decodeUnknownOption(StoredCheckIns)(row));

  return { on: stored?.off !== 1, zone: stored?.zone ?? null, pinned: stored?.zone_pinned === 1 };
});

const LOG_KEPT = 60;

/** B's TaskFeed #logStep (src/automations/tasks.ts): a step, and the log trimmed to its newest LOG_KEPT, together. */
export const logStep = (task: string, line: string, at: number) =>
  Effect.gen(function* () {
    const sql = yield* Sql;

    yield* sql.transaction(
      Effect.gen(function* () {
        yield* sql.exec(`INSERT INTO ky_task_steps (task, call, at, state, text, input) VALUES (?, NULL, ?, 'done', ?, '')`, task, at, line);
        yield* sql.exec(
          `DELETE FROM ky_task_steps WHERE task = ? AND seq <= (SELECT seq FROM ky_task_steps WHERE task = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
          task,
          task,
          LOG_KEPT
        );
      })
    );

    return {};
  });
```

Done when the domain's code reaches `ctx.storage` only through `Sql`, every table and restore name matches B's, the domain's sync methods are still sync, and the worker e2e suites that cover its tables (`src/tests/backup.test.ts` and the domain's own) pass.
