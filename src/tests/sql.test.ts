import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { makeEdge } from "../core/edge";
import { Sql, makeSql } from "../core/sql";

/**
 * The `Sql` service (src/core/sql.ts) over a real Durable Object's storage: what it reads, what it
 * refuses, and that a transaction's failure, defect or wait rolls back every write in it.
 */

/** Runs `work` inside a Durable Object of its own, with a scratch table. */
function inside<T>(work: (storage: DurableObjectStorage) => T): Promise<T> {
  return runInDurableObject(env.Vault.getByName(crypto.randomUUID()), (_, state) => {
    state.storage.sql.exec("CREATE TABLE core_sql_probe (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");

    return work(state.storage);
  });
}

const Probe = Schema.Struct({ id: Schema.Number, text: Schema.String });

const texts = (storage: DurableObjectStorage) => storage.sql.exec<{ text: string }>("SELECT text FROM core_sql_probe ORDER BY id").toArray().map((row) => row.text);

describe("Sql", () => {
  it("reads rows, decoded, and fails a statement SQLite refuses with its query", async () => {
    await inside((storage) => {
      const sql = makeSql(storage);

      Effect.runSync(sql.exec("INSERT INTO core_sql_probe (text) VALUES (?)", "tea"));
      expect(Effect.runSync(sql.rows(Probe, "SELECT id, text FROM core_sql_probe"))).toEqual([{ id: 1, text: "tea" }]);

      const refused = Effect.runSyncExit(sql.exec("SELECT nope FROM core_sql_probe"));

      expect(Exit.isFailure(refused) && JSON.stringify(refused.cause)).toContain("SELECT nope FROM core_sql_probe");
    });
  });

  it("fails a row that isn't the shape asked for", async () => {
    await inside((storage) => {
      const sql = makeSql(storage);

      Effect.runSync(sql.exec("INSERT INTO core_sql_probe (text) VALUES (?)", "tea"));
      const exit = Effect.runSyncExit(sql.rows(Schema.Struct({ id: Schema.String }), "SELECT id FROM core_sql_probe"));

      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("SqlError");
    });
  });

  it("commits a transaction that succeeds", async () => {
    await inside((storage) => {
      const sql = makeSql(storage);

      Effect.runSync(sql.transaction(Effect.andThen(sql.exec("INSERT INTO core_sql_probe (text) VALUES ('a')"), sql.exec("INSERT INTO core_sql_probe (text) VALUES ('b')"))));
      expect(texts(storage)).toEqual(["a", "b"]);
    });
  });

  it("rolls back every write of a transaction that fails, dies or waits, and keeps what came before", async () => {
    await inside((storage) => {
      const sql = makeSql(storage);
      const write = sql.exec("INSERT INTO core_sql_probe (text) VALUES ('lost')");

      Effect.runSync(sql.exec("INSERT INTO core_sql_probe (text) VALUES ('kept')"));
      expect(Exit.isFailure(Effect.runSyncExit(sql.transaction(Effect.andThen(write, Effect.fail("no")))))).toBe(true);
      expect(Exit.isFailure(Effect.runSyncExit(sql.transaction(Effect.andThen(write, Effect.die(new Error("bug"))))))).toBe(true);
      expect(Exit.isFailure(Effect.runSyncExit(sql.transaction(Effect.andThen(write, Effect.promise(() => Promise.resolve())))))).toBe(true);
      expect(texts(storage)).toEqual(["kept"]);
    });
  });

  it("runs behind a domain's edge, synchronously", async () => {
    await inside((storage) => {
      const edge = makeEdge(Sql.layer(storage));
      const read = Effect.gen(function* () {
        const sql = yield* Sql;

        yield* sql.exec("INSERT INTO core_sql_probe (text) VALUES ('edge')");

        return { rows: yield* Effect.orDie(sql.rows(Probe, "SELECT id, text FROM core_sql_probe")) };
      }).pipe(Effect.orDie);

      expect(edge.run(read)).toEqual({ rows: [{ id: 1, text: "edge" }] });
    });
  });
});
