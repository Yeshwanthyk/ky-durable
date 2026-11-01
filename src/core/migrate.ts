/**
 * ky's data migrations: numbered changes to what a ky has stored, each applied once per ky, in order, so a
 * release can change data an older release wrote. The list is src/migrations.ts; this runs it.
 *
 * A migration's level is its place in that list, 1 for the first. MIGRATION_TABLE records each one applied,
 * so a ky's level is how many it has. It runs when the agent starts, before any field of it makes or reads
 * a table, and when a restore swaps an older archive in (src/backup.ts), and either way every pending one
 * runs in one `transactionSync`: a failure anywhere leaves storage exactly as the last release left it, so
 * rolling the release back brings the ky back. The agent then throws, and serves nothing until it can.
 *
 * A fresh ky, with no table yet, has nothing to change: it records every migration as applied, unrun. So a
 * migration only ever runs on data at the level before it, with the tables that level had: none of a later
 * release's, as the domains make theirs only after this.
 *
 * MIGRATION_TABLE's name never changes, whatever a migration renames: it is how every release, and every
 * archive, says what level its data is at.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Refusable } from "./edge";
import { makeSql, Sql, type SqlError } from "./sql";

export const MIGRATION_TABLE = "data_migrations";

/** One change to stored data. Its name is its identity: once released, it is never renamed, reordered or removed. */
export interface Migration {
  readonly name: string;
  /**
   * Tables it renames or drops. An archive from before it may hold them, so a restore puts them back for it to
   * migrate (src/tables.ts). A rename drops the new name first if it is there: on a restore, that is the live
   * table the archive replaces.
   */
  readonly retires?: readonly string[];
  /**
   * The change, on data at the level before it. It may fail or die: either rolls back every pending migration.
   * It rewrites values or renames whole tables. A column change can't reach an older archive: a restore checks
   * the archive's columns against the live table before any migration runs.
   */
  readonly run: Effect.Effect<void, SqlError, Sql>;
}

/** Where a ky's data stands after a run: its level, and the migrations that ran, none on a fresh ky. */
export type DataLevel = { readonly level: number; readonly ran: readonly string[] };

/** The data is from a release with more migrations than this one. */
class DataTooNew extends Schema.TaggedError<DataTooNew>()("DataTooNew", { level: Schema.Number, known: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `ky's data is at migration ${this.level}, from a newer release; this release knows ${this.known}. Deploy that release, or a newer one.`;
  }
}

/** The ky recorded a migration this release has another one at the place of. */
class DataDiverged extends Schema.TaggedError<DataDiverged>()("DataDiverged", { level: Schema.Number, recorded: Schema.String, expected: Schema.String }) implements Refusable {
  get refusal(): string {
    return `ky's data ran migration ${this.level} as "${this.recorded}", but this release's migration ${this.level} is "${this.expected}": a release changed a migration it had shipped. Deploy the release that ran it.`;
  }
}

/** A migration failed; nothing it or any other pending one wrote was kept. */
class MigrationFailed extends Schema.TaggedError<MigrationFailed>()("MigrationFailed", { level: Schema.Number, name: Schema.String, cause: Schema.String }) implements Refusable {
  get refusal(): string {
    return `ky's data migration ${this.level} ("${this.name}") failed, so nothing was changed and ky serves nothing on this release: ${this.cause}. Roll back to the release before it.`;
  }
}

const Applied = Schema.Struct({ level: Schema.Number, name: Schema.String });

const Count = Schema.Struct({ count: Schema.Number });

/** Tables other than SQLite's, the runtime's and the record's own: a ky with none has no data yet. */
const DATA_TABLES = `SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'
  AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name != '${MIGRATION_TABLE}'`;

/** The applied migrations, checked against `migrations`: how many, or why this release can't go on from them. */
const checkApplied = (migrations: readonly Migration[], applied: readonly (typeof Applied.Type)[]) =>
  Effect.gen(function* () {
    if (applied.length > migrations.length) return yield* new DataTooNew({ level: applied.length, known: migrations.length });

    for (const [at, row] of applied.entries()) {
      const expected = migrations[at]?.name ?? "";

      if (row.level !== at + 1 || row.name !== expected) return yield* new DataDiverged({ level: at + 1, recorded: row.name, expected });
    }

    return applied.length;
  });

/** Brings the data to the level of `migrations`, on the caller's transaction. */
const migrate = (migrations: readonly Migration[]) =>
  Effect.gen(function* () {
    const sql = yield* Sql;

    yield* sql.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (level INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, ran INTEGER NOT NULL)`);
    const level = yield* checkApplied(migrations, yield* sql.rows(Applied, `SELECT level, name FROM ${MIGRATION_TABLE} ORDER BY level`));
    const fresh = level === 0 && ((yield* sql.rows(Count, DATA_TABLES))[0]?.count ?? 0) === 0;
    const ran: string[] = [];

    for (const [at, migration] of migrations.entries()) {
      if (at < level) continue;
      // Every pending migration commits at once, so the first one's time is the mark that matters: a point-in-time
      // restore to just before it brings back the data as it was.
      const appliedAt = yield* Clock.currentTimeMillis;

      if (!fresh) {
        yield* migration.run.pipe(
          Effect.catchCause((cause) => Effect.fail(new MigrationFailed({ level: at + 1, name: migration.name, cause: String(Cause.squash(cause)) })))
        );
        ran.push(migration.name);
      }

      yield* sql.exec(`INSERT INTO ${MIGRATION_TABLE} (level, name, applied_at, ran) VALUES (?, ?, ?, ?)`, at + 1, migration.name, appliedAt, fresh ? 0 : 1);
    }

    return { level: migrations.length, ran } satisfies DataLevel;
  });

/**
 * Brings `storage`'s data to the level of `migrations`, every pending one in one transaction; inside a caller's
 * transaction, on that one. Throws why it can't, logged, and then nothing was changed.
 */
export function migrateStorage(storage: DurableObjectStorage, migrations: readonly Migration[]): DataLevel {
  const sql = makeSql(storage);
  const exit = Effect.runSyncExit(sql.transaction(migrate(migrations)).pipe(Effect.provideService(Sql, sql)));

  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  const why = Option.isSome(failure) && "refusal" in failure.value ? failure.value.refusal : `ky's data couldn't be migrated: ${String(Cause.squash(exit.cause))}`;

  console.error(why);
  throw new Error(why);
}
