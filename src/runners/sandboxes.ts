import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Sql } from "../core/sql";
import { CLOUD, isMachineName } from "../machines/contract";
import {
  AtCap,
  BadIdle,
  IDLE_MAX,
  NameTaken,
  NoKeptDisk,
  NoSandbox,
  NotAName,
  NotARepo,
  RepoOwned,
  RUNNER_TABLES,
  SANDBOX_CAP,
  type Sandbox,
  type SandboxChange,
  type SandboxDraft
} from "./contract";

const SANDBOXES = RUNNER_TABLES.sandboxes;

const SEEDED = RUNNER_TABLES.seeded;

const Row = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  repos: Schema.String,
  idle_minutes: Schema.NullOr(Schema.Number),
  is_default: Schema.Number,
  created_at: Schema.Number,
  deleted_at: Schema.NullOr(Schema.Number)
});

const COLUMNS = Object.keys(Row.fields).join(", ");

const asRow = Schema.decodeUnknownOption(Row);

const asRepos = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

const newId = () => `sb-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const sandboxOf = (row: typeof Row.Type): Sandbox => ({
  id: row.id,
  name: row.name,
  repos: Option.getOrElse(asRepos(row.repos), () => []),
  idleMinutes: row.idle_minutes,
  isDefault: row.is_default === 1,
  createdAt: row.created_at,
  deletedAt: row.deleted_at
});

const cleanRepos = (repos: readonly string[]) =>
  Effect.gen(function* () {
    const clean = [...new Set(repos.map((repo) => repo.trim().toLowerCase()))];
    const bad = clean.find((repo) => !REPO.test(repo));

    if (bad !== undefined) return yield* new NotARepo({ repo: bad });

    return clean;
  });

export interface SandboxRegistry {
  readonly migrate: Effect.Effect<void>;
  readonly seeded: Effect.Effect<void>;
  readonly all: Effect.Effect<Sandbox[]>;
  readonly keep: (lost: readonly Sandbox[]) => Effect.Effect<void>;
  readonly live: Effect.Effect<Sandbox[]>;
  readonly kept: Effect.Effect<Sandbox[]>;
  readonly get: (id: string) => Effect.Effect<Sandbox | undefined>;
  readonly named: (name: string) => Effect.Effect<Sandbox | undefined>;
  readonly owner: (repo: string) => Effect.Effect<Sandbox | undefined>;
  readonly reposFor: (id: string) => Effect.Effect<readonly string[] | "all" | null>;
  readonly create: (draft: SandboxDraft, taken: (name: string) => boolean) => Effect.Effect<Sandbox, NotAName | NameTaken | AtCap | NotARepo | RepoOwned | NoKeptDisk>;
  readonly change: (id: string, change: SandboxChange) => Effect.Effect<Sandbox, NoSandbox | NotARepo | RepoOwned | BadIdle>;
  readonly delete: (id: string) => Effect.Effect<Sandbox, NoSandbox>;
  readonly forget: (id: string) => Effect.Effect<Sandbox, NoKeptDisk>;
}

const make = Effect.gen(function* () {
  const sql = yield* Sql;
  const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));

  yield* exec(`CREATE TABLE IF NOT EXISTS ${SANDBOXES} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repos TEXT NOT NULL DEFAULT '[]',
      idle_minutes INTEGER,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER)`);
  yield* exec(`CREATE UNIQUE INDEX IF NOT EXISTS ky_sandboxes_live_name ON ${SANDBOXES} (name) WHERE deleted_at IS NULL`);
  yield* exec(`CREATE TABLE IF NOT EXISTS ${SEEDED} (at INTEGER NOT NULL)`);

  const rows = (where: string, ...params: SqlStorageValue[]) =>
    Effect.map(exec(`SELECT ${COLUMNS} FROM ${SANDBOXES} WHERE ${where}`, ...params), (found) => found.flatMap((row) => Option.toArray(Option.map(asRow(row), sandboxOf))));

  const live = rows("deleted_at IS NULL ORDER BY is_default DESC, name");

  const get = (id: string) => Effect.map(rows("id = ?", id), ([sandbox]) => sandbox);

  const named = (name: string) => Effect.map(rows("deleted_at IS NULL AND name = ?", name), ([sandbox]) => sandbox);

  const owner = (repo: string) => {
    const wanted = repo.trim().toLowerCase();

    return Effect.map(live, (sandboxes) => sandboxes.find((sandbox) => sandbox.repos.includes(wanted)));
  };

  const written = (id: string) => Effect.flatMap(get(id), (sandbox) => (sandbox ? Effect.succeed(sandbox) : Effect.die(new Error(`The sandbox ${id} wasn't written.`))));

  const liveOne = (id: string) =>
    Effect.flatMap(get(id), (sandbox) => (sandbox && sandbox.deletedAt === null ? Effect.succeed(sandbox) : Effect.fail(new NoSandbox({ id }))));

  const keptOne = (id: string) =>
    Effect.flatMap(get(id), (sandbox) => (sandbox && sandbox.deletedAt !== null ? Effect.succeed(sandbox) : Effect.fail(new NoKeptDisk({ id }))));

  const checkOwners = (repos: readonly string[], id?: string) =>
    Effect.forEach(repos, (repo) =>
      Effect.flatMap(owner(repo), (found) => (found && found.id !== id ? Effect.fail(new RepoOwned({ repo, owner: found.name })) : Effect.void))
    );

  const seeded = Effect.gen(function* () {
    yield* exec(`DELETE FROM ${SEEDED}`);
    yield* exec(`INSERT INTO ${SEEDED} (at) VALUES (?)`, yield* Clock.currentTimeMillis);
  });

  return {
    migrate: Effect.gen(function* () {
      if ((yield* exec(`SELECT at FROM ${SEEDED}`)).length > 0) return;
      yield* exec(
        `INSERT INTO ${SANDBOXES} (id, name, is_default, created_at) SELECT ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM ${SANDBOXES})`,
        CLOUD,
        CLOUD,
        yield* Clock.currentTimeMillis
      );
      yield* seeded;
    }),
    seeded,
    all: rows("1 = 1 ORDER BY created_at"),
    keep: (lost) =>
      Effect.forEach(
        lost,
        (sandbox) =>
          Effect.gen(function* () {
            yield* exec(
              `INSERT OR IGNORE INTO ${SANDBOXES} (id, name, repos, idle_minutes, is_default, created_at, deleted_at) VALUES (?, ?, ?, ?, 0, ?, ?)`,
              sandbox.id,
              sandbox.name,
              JSON.stringify(sandbox.repos),
              sandbox.idleMinutes,
              sandbox.createdAt,
              sandbox.deletedAt ?? (yield* Clock.currentTimeMillis)
            );
          }),
        { discard: true }
      ),
    live,
    kept: rows("deleted_at IS NOT NULL ORDER BY deleted_at DESC"),
    get,
    named,
    owner,
    reposFor: (id) =>
      Effect.map(get(id), (sandbox) => {
        if (!sandbox || sandbox.deletedAt !== null) return null;

        return sandbox.repos.length === 0 ? "all" : sandbox.repos;
      }),
    create: (draft, taken) =>
      Effect.gen(function* () {
        const name = draft.name.trim();

        if (!isMachineName(name)) return yield* new NotAName();

        if (taken(name) || (yield* named(name))) return yield* new NameTaken({ name });

        if ((yield* live).length >= SANDBOX_CAP) return yield* new AtCap();
        const repos = yield* cleanRepos(draft.repos ?? []);

        yield* checkOwners(repos);
        const first = (yield* live).length === 0 ? 1 : 0;

        if (draft.from !== undefined) {
          const kept = yield* keptOne(draft.from);

          yield* exec(
            `UPDATE ${SANDBOXES} SET name = ?, repos = ?, is_default = ?, created_at = ?, deleted_at = NULL WHERE id = ?`,
            name,
            JSON.stringify(repos),
            first,
            yield* Clock.currentTimeMillis,
            kept.id
          );

          return yield* written(kept.id);
        }

        const id = newId();

        yield* exec(`INSERT INTO ${SANDBOXES} (id, name, repos, is_default, created_at) VALUES (?, ?, ?, ?, ?)`, id, name, JSON.stringify(repos), first, yield* Clock.currentTimeMillis);

        return yield* written(id);
      }),
    change: (id, change) =>
      Effect.gen(function* () {
        yield* liveOne(id);

        if (change.repos !== undefined) {
          const repos = yield* cleanRepos(change.repos);

          yield* checkOwners(repos, id);
          yield* exec(`UPDATE ${SANDBOXES} SET repos = ? WHERE id = ?`, JSON.stringify(repos), id);
        }

        if (change.idleMinutes !== undefined) {
          const minutes = change.idleMinutes;

          if (minutes !== null && !(Number.isInteger(minutes) && minutes > 0 && minutes <= IDLE_MAX)) return yield* new BadIdle();
          yield* exec(`UPDATE ${SANDBOXES} SET idle_minutes = ? WHERE id = ?`, minutes, id);
        }

        if (change.isDefault) yield* exec(`UPDATE ${SANDBOXES} SET is_default = (id = ?)`, id);

        return yield* written(id);
      }),
    delete: (id) =>
      Effect.gen(function* () {
        yield* liveOne(id);
        yield* exec(`UPDATE ${SANDBOXES} SET deleted_at = ?, is_default = 0 WHERE id = ?`, yield* Clock.currentTimeMillis, id);

        return yield* written(id);
      }),
    forget: (id) =>
      Effect.gen(function* () {
        const kept = yield* keptOne(id);

        yield* exec(`DELETE FROM ${SANDBOXES} WHERE id = ?`, id);

        return kept;
      })
  } satisfies SandboxRegistry;
});

export class Registry extends Context.Service<Registry, SandboxRegistry>()("ky/runners/Registry") {
  static readonly layer = Layer.effect(Registry)(make);
}
