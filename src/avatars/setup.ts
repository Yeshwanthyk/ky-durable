import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Sql } from "../core/sql";
import { AVATAR_TABLES, NotARepo, PageUnknown, type SelfEdit, type SetupView } from "./contract";

const TABLE = AVATAR_TABLES.setup;

const REPO = /^[\w.-]+\/[\w.-]+$/;

type Key = "repo" | "url" | "seeded" | "origin";

const SetupRow = Schema.Struct({ value: Schema.String });

const originOf = (page: string) => Effect.orDie(Effect.try(() => new URL(page).origin));

export class Places extends Context.Service<
  Places,
  {
    setRepo(repo: string, page: string | null): Effect.Effect<Record<string, never>, NotARepo | PageUnknown>;
    readonly view: Effect.Effect<Omit<SetupView, "missing">>;
    readonly selfEdit: Effect.Effect<SelfEdit | undefined>;
    readonly firstStart: Effect.Effect<boolean>;
    readonly origin: Effect.Effect<string | null>;
    opened(page: string): Effect.Effect<void>;
    moved(origin: string): Effect.Effect<void>;
  }
>()("ky/avatars/Places") {
  static readonly layer = Layer.effect(
    Places,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
      const get = (key: Key) => Effect.map(Effect.orDie(sql.rows(SetupRow, `SELECT value FROM ${TABLE} WHERE key = ?`, key)), ([row]) => row?.value);

      const put = (key: Key, value: string) =>
        exec(`INSERT INTO ${TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);

      const seed = Effect.flatMap(Clock.currentTimeMillis, (now) => put("seeded", String(now)));

      yield* exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

      return Places.of({
        setRepo: Effect.fnUntraced(function* (repo, page) {
          const value = repo.trim();

          if (value === "") {
            yield* exec(`DELETE FROM ${TABLE} WHERE key = 'repo'`);
          } else {
            if (!REPO.test(value)) return yield* new NotARepo({ repo: value });

            if (!page) return yield* new PageUnknown();
            yield* put("repo", value);
            yield* put("url", yield* originOf(page));
          }

          return {};
        }),
        view: Effect.all({ repo: Effect.map(get("repo"), (repo) => repo ?? null), url: Effect.map(get("url"), (url) => url ?? null) }),
        selfEdit: Effect.map(Effect.all([get("repo"), get("url")]), ([repo, url]) => (repo && url ? { repo, url } : undefined)),
        firstStart: Effect.gen(function* () {
          if ((yield* get("seeded")) !== undefined) return false;
          yield* seed;

          return true;
        }),
        origin: Effect.map(get("origin"), (origin) => origin ?? null),
        opened: Effect.fnUntraced(function* (page) {
          const origin = yield* originOf(page);

          if ((yield* get("origin")) !== origin) yield* put("origin", origin);
        }),
        moved: Effect.fnUntraced(function* (origin) {
          if ((yield* get("seeded")) === undefined) yield* seed;

          if ((yield* get("url")) !== undefined) yield* put("url", origin);

          if ((yield* get("origin")) !== undefined) yield* put("origin", origin);
        })
      });
    })
  );
}
