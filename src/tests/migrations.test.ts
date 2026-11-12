import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { type Archive, readArchive, readTar, restoreArchive } from "../archive";
import { backupRoute, Backups } from "../backup";
import { MIGRATION_TABLE, type Migration, migrateStorage } from "../core/migrate";
import { Sql } from "../core/sql";
import { MIGRATIONS } from "../migrations";
import { PiAgent } from "../server";
import { restores } from "../tables";
import { agent, inside } from "./drive";

/**
 * Data migrations (src/core/migrate.ts): each applied once per ky, in order, all pending in one transaction, before
 * the agent's domains touch a table; a fresh ky records them unrun; a failure changes nothing and keeps the agent
 * from serving; a restore brings an older archive's data to this release's level and refuses a newer one's.
 */

/** Runs `work` on the storage of a Durable Object of its own, emptied of the Vault's tables: a fresh ky's. */
function scratch<T>(work: (storage: DurableObjectStorage, state: DurableObjectState) => T): Promise<T> {
  return runInDurableObject(env.Vault.getByName(crypto.randomUUID()), (_, state) => {
    for (const table of tables(state.storage)) state.storage.sql.exec(`DROP TABLE ${table}`);

    return work(state.storage, state);
  });
}

// SAFETY: each caller's query selects exactly the columns of its T.
const all = <T>(storage: DurableObjectStorage, query: string) => storage.sql.exec(query).toArray() as T[];

const tables = (storage: DurableObjectStorage) =>
  all<{ name: string }>(storage, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").map((row) => row.name);

const recorded = (storage: DurableObjectStorage) => all<{ level: number; name: string; ran: number }>(storage, `SELECT level, name, ran FROM ${MIGRATION_TABLE} ORDER BY level`);

const notes = (storage: DurableObjectStorage) => all<{ note: string }>(storage, "SELECT note FROM notes ORDER BY id").map((row) => row.note);

const exec = (query: string) =>
  Effect.gen(function* () {
    yield* (yield* Sql).exec(query);
  });

/** A migration that writes `note` into notes. */
const writes = (name: string, note: string): Migration => ({ name, run: exec(`INSERT INTO notes (note) VALUES ('${note}')`) });

const first = writes("first", "by the first");

const second = writes("second", "by the second");

/** A ky with data at level 0: a table the migrations read, written before any of them. */
const withData = (storage: DurableObjectStorage) => {
  storage.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  storage.sql.exec("INSERT INTO notes (note) VALUES ('the owner''s')");
};

describe("data migrations", () => {
  it("records every migration as applied, unrun, on a fresh ky", async () => {
    await scratch((storage) => {
      expect(tables(storage)).toEqual([]);

      expect(migrateStorage(storage, [writes("needs notes", "never")])).toEqual({ level: 1, ran: [] });
      // It didn't run: there was no notes table for it to write to, and none was made.
      expect(tables(storage)).toEqual([MIGRATION_TABLE]);
      expect(recorded(storage)).toEqual([{ level: 1, name: "needs notes", ran: 0 }]);
    });
  });

  it("runs only the pending migrations of a ky with data, in order, each once", async () => {
    await scratch((storage) => {
      withData(storage);

      expect(migrateStorage(storage, [first])).toEqual({ level: 1, ran: ["first"] });
      // The next release adds one: only it runs, and again nothing does.
      expect(migrateStorage(storage, [first, second])).toEqual({ level: 2, ran: ["second"] });
      expect(migrateStorage(storage, [first, second])).toEqual({ level: 2, ran: [] });

      expect(notes(storage)).toEqual(["the owner's", "by the first", "by the second"]);
      expect(recorded(storage)).toEqual([
        { level: 1, name: "first", ran: 1 },
        { level: 2, name: "second", ran: 1 }
      ]);
    });
  });

  it("keeps nothing of a failed run, and fails again on every start until a release fixes it", async () => {
    await scratch((storage) => {
      withData(storage);
      const fails: Migration = { name: "fails", run: Effect.andThen(exec("INSERT INTO notes (note) VALUES ('half')"), exec("SELECT nope FROM notes")) };
      const dies: Migration = { name: "dies", run: Effect.die(new Error("a bug in the migration")) };

      expect(() => migrateStorage(storage, [first, fails])).toThrow(/migration 2 \("fails"\) failed, so nothing was changed/);
      expect(() => migrateStorage(storage, [first, fails])).toThrow(/migration 2 \("fails"\) failed/);
      expect(() => migrateStorage(storage, [first, dies])).toThrow(/migration 2 \("dies"\) failed.*a bug in the migration/);
      // Not the first's write, nor even the record's table: the run is one transaction, so the last release's level holds.
      expect(notes(storage)).toEqual(["the owner's"]);
      expect(tables(storage)).toEqual(["notes"]);

      expect(migrateStorage(storage, [first, second])).toEqual({ level: 2, ran: ["first", "second"] });
    });
  });

  it("refuses data a newer release migrated, or one that ran another migration in a place, changing nothing", async () => {
    await scratch((storage) => {
      withData(storage);
      migrateStorage(storage, [first, second]);

      expect(() => migrateStorage(storage, [first])).toThrow(/at migration 2, from a newer release; this release knows 1/);
      expect(() => migrateStorage(storage, [first, writes("renamed", "x")])).toThrow(/ran migration 2 as "second", but this release's migration 2 is "renamed"/);
      expect(() => migrateStorage(storage, [writes("other", "x"), second, writes("third", "x")])).toThrow(/ran migration 1 as "first"/);
      expect(notes(storage)).toEqual(["the owner's", "by the first", "by the second"]);
      expect(recorded(storage).map((row) => row.name)).toEqual(["first", "second"]);
    });
  });

  it("migrates the agent before its domains start, and a refusal stops it before any of them", async () => {
    const name = `migrated-${crypto.randomUUID().slice(0, 8)}`;

    expect(await inside(name, (_instance, state) => recorded(state.storage).length)).toBe(MIGRATIONS.length);

    // The agent made on data from a release with one more migration than this one. Made here, not over RPC: a throw
    // over RPC also surfaces as an unhandled rejection in vitest-pool-workers.
    await scratch((storage, state) => {
      migrateStorage(storage, [...MIGRATIONS, writes("from a newer release", "x")]);

      expect(() => new PiAgent(state, env)).toThrow(/at migration \d+, from a newer release/);
      // No domain made its tables first.
      expect(tables(storage)).toEqual([MIGRATION_TABLE]);
    });
  });
});

/** The archive the Worker's /api/backup streams for the agent `name`. */
async function backUp(name: string): Promise<Archive> {
  const request = new Request("https://ky.test/api/backup");
  const response = (await backupRoute(request, env, new URL(request.url), agent(name)))!;

  return readArchive(readTar(new Uint8Array(await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())));
}

/** The agent's half of a restore of `archive` into `name`, as a release with `migrations` runs it. */
function restoreWith(name: string, archive: Archive, migrations: readonly Migration[]) {
  return inside(name, (_instance, state) => {
    const backups = new Backups(state.storage, migrations);

    backups.begin(archive.manifest, archive.end, false);

    for (const part of archive.parts) backups.stage(part.table, part.text);

    return backups.finish(false, () => {});
  });
}

describe("restoring across data migrations", () => {
  /** A later release's: notes moves to a new name, so a restore must put the old table back for it. */
  const rename: Migration = {
    name: "rename fixture_notes",
    retires: ["fixture_notes"],
    run: Effect.andThen(exec("DROP TABLE IF EXISTS fixture_renamed"), exec("ALTER TABLE fixture_notes RENAME TO fixture_renamed"))
  };

  /** An agent at this release's level, with notes in a table the next release renames; its archive. */
  async function olderArchive(): Promise<Archive> {
    const source = `older-${crypto.randomUUID().slice(0, 8)}`;

    await inside(source, (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE fixture_notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
      state.storage.sql.exec("INSERT INTO fixture_notes (note) VALUES ('kept across releases'), ('and this')");
    });

    return backUp(source);
  }

  it("puts back an older archive's data, at its level, and migrates it there", async () => {
    const archive = await olderArchive();
    expect(archive.manifest.schemas.data).toBe(MIGRATIONS.length);
    expect(restores("fixture_notes", MIGRATIONS)).toBe(false);

    const target = `newer-${crypto.randomUUID().slice(0, 8)}`;
    // The newer release's own table, as its domain made it on start: the archive's data replaces it.
    await inside(target, (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE fixture_renamed (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
      state.storage.sql.exec("INSERT INTO fixture_renamed (note) VALUES ('the live one')");
    });

    const { leftOut } = await restoreWith(target, archive, [...MIGRATIONS, rename]);

    expect(leftOut.map((each) => each.what)).not.toContain("Table fixture_notes");
    await inside(target, (_instance, state) => {
      expect(all<{ note: string }>(state.storage, "SELECT note FROM fixture_renamed ORDER BY id").map((row) => row.note)).toEqual(["kept across releases", "and this"]);
      expect(tables(state.storage)).not.toContain("fixture_notes");
      expect(recorded(state.storage).at(-1)).toEqual({ level: MIGRATIONS.length + 1, name: "rename fixture_notes", ran: 1 });
    });
  });

  it("keeps the live data when a migration fails on the archive's", async () => {
    const archive = await olderArchive();
    const target = `kept-${crypto.randomUUID().slice(0, 8)}`;

    const before = await inside(target, (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE fixture_renamed (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
      state.storage.sql.exec("INSERT INTO fixture_renamed (note) VALUES ('the live one')");

      return tables(state.storage);
    });

    // It drops the live table, as the rename does, then fails: the drop must not stick.
    const fails: Migration = { name: "fails", retires: ["fixture_notes"], run: Effect.andThen(exec("DROP TABLE IF EXISTS fixture_renamed"), exec("SELECT nope FROM fixture_notes")) };

    await expect(restoreWith(target, archive, [...MIGRATIONS, fails])).rejects.toThrow(/migration \d+ \("fails"\) failed/);
    await inside(target, (_instance, state) => {
      expect(tables(state.storage).filter((table) => !table.startsWith("ky_restore"))).toEqual(before);
      expect(all<{ note: string }>(state.storage, "SELECT note FROM fixture_renamed").map((row) => row.note)).toEqual(["the live one"]);
      expect(recorded(state.storage)).toHaveLength(MIGRATIONS.length);
    });
  });

  it("refuses an archive whose data a newer release migrated", async () => {
    const archive = await olderArchive();
    const newer: Archive = { ...archive, manifest: { ...archive.manifest, schemas: { ...archive.manifest.schemas, data: MIGRATIONS.length + 1 } } };
    const target = `refuses-${crypto.randomUUID().slice(0, 8)}`;

    const send = (path: string, init?: RequestInit) => {
      const request = new Request(`https://restored.test${path}`, init);

      return backupRoute(request, env, new URL(request.url), agent(target))!;
    };

    await expect(restoreArchive(newer, send, false)).rejects.toThrow(/from a newer release; this ky's release knows \d+\. Upgrade this ky, then restore/);
    await inside(target, (_instance, state) => expect(tables(state.storage)).not.toContain("fixture_notes"));
  });
});
