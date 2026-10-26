import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type, { type Static } from "typebox";
import type { Edge, Refusable } from "../core/edge.ts";
import { Sql } from "../core/sql.ts";

export const SoulChangeSchema = Type.Object({
  action: Type.Union([Type.Literal("edit"), Type.Literal("patch"), Type.Literal("revert")]),
  body: Type.Optional(Type.String()),
  old: Type.Optional(Type.String()),
  new: Type.Optional(Type.String()),
  version: Type.Optional(Type.Number())
});

export type SoulChange = Static<typeof SoulChangeSchema>;

const SoulVersion = Schema.Struct({
  id: Schema.Int,
  action: Schema.String,
  actor: Schema.String,
  conversation: Schema.NullOr(Schema.String),
  body: Schema.String,
  created_at: Schema.Number
});

export type SoulVersion = typeof SoulVersion.Type;

export type SoulView = { readonly body: string; readonly version: number; readonly updated_at: number };

const ColumnRow = Schema.Struct({ name: Schema.String });

const VersionRow = Schema.Struct({ version: Schema.Int });

const decodeVersion = Schema.decodeUnknownOption(SoulVersion);

const SOUL_CHARS = 20_000;

class Missing extends Schema.TaggedError<Missing>()("Missing", { label: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.label} does not exist.`;
  }
}

class Empty extends Schema.TaggedError<Empty>()("Empty", { label: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.label} cannot be empty.`;
  }
}

class TooLong extends Schema.TaggedError<TooLong>()("TooLong", { label: Schema.String, length: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `${this.label} would be ${this.length} characters; keep it under ${SOUL_CHARS}.`;
  }
}

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { label: Schema.String }) implements Refusable {
  get refusal(): string {
    return `The text to replace is not in ${this.label}.`;
  }
}

class Ambiguous extends Schema.TaggedError<Ambiguous>()("Ambiguous", { label: Schema.String, count: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `The text to replace appears ${this.count} times in ${this.label}; quote more of it.`;
  }
}

class NoVersion extends Schema.TaggedError<NoVersion>()("NoVersion", { label: Schema.String, version: Schema.Number }) implements Refusable {
  get refusal(): string {
    return `${this.label} has no version ${this.version}.`;
  }
}

const NEEDS = { edit: "edit needs a body.", patch: "patch needs old and new.", revert: "revert needs a version." } as const;

class Incomplete extends Schema.TaggedError<Incomplete>()("Incomplete", { action: Schema.Literals(["edit", "patch", "revert"]) }) implements Refusable {
  get refusal(): string {
    return NEEDS[this.action];
  }
}

const patched = (label: string, was: string, old: string, replacement: string): Effect.Effect<string, NotFound | Ambiguous> => {
  const count = was.split(old).length - 1;

  if (old === "" || count === 0) return Effect.fail(new NotFound({ label }));

  if (count > 1) return Effect.fail(new Ambiguous({ label, count }));

  return Effect.succeed(was.replace(old, () => replacement));
};

const checked = (label: string, body: string): Effect.Effect<string, Empty | TooLong> => {
  if (body.trim() === "") return Effect.fail(new Empty({ label }));

  if (body.length > SOUL_CHARS) return Effect.fail(new TooLong({ label, length: body.length }));

  return Effect.succeed(body);
};

export type VersionRefusal = Missing | Empty | TooLong | NotFound | Ambiguous | NoVersion | Incomplete;

type VersionedFile = {
  readonly key: string;
  readonly label: string;
  readonly template?: string;
  readonly listeners: ReadonlySet<() => void>;
};

export class Versions extends Context.Service<
  Versions,
  {
    readonly current: (file: VersionedFile) => Effect.Effect<SoulVersion, Missing>;
    readonly history: (file: VersionedFile) => Effect.Effect<SoulVersion[]>;
    readonly apply: (file: VersionedFile, change: SoulChange, actor: string, conversation: string | null) => Effect.Effect<string, VersionRefusal>;
  }
>()("ky/dreaming/Versions") {
  static readonly layer = Layer.effect(
    Versions,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));

      yield* exec(`CREATE TABLE IF NOT EXISTS ky_soul_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        conversation TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);

      const columns = (yield* Effect.orDie(sql.rows(ColumnRow, "PRAGMA table_info(ky_soul_versions)"))).map((column) => column.name);

      if (!columns.includes("key")) yield* exec("ALTER TABLE ky_soul_versions ADD COLUMN key TEXT NOT NULL DEFAULT 'soul'");

      if (!columns.includes("version")) {
        yield* exec("ALTER TABLE ky_soul_versions ADD COLUMN version INTEGER");
        yield* exec("UPDATE ky_soul_versions SET version = id");
      }

      const versions = (file: VersionedFile, limit = -1) =>
        Effect.map(
          exec(
            "SELECT version AS id, action, actor, conversation, body, created_at FROM ky_soul_versions WHERE key = ? ORDER BY version DESC LIMIT ?",
            file.key,
            limit
          ),
          (rows) => rows.flatMap((row) => Option.toArray(decodeVersion(row)))
        );

      const insert = Effect.fn("Versions.insert")(function* (file: VersionedFile, action: string, actor: string, conversation: string | null, body: string) {
        const now = yield* Clock.currentTimeMillis;

        const [inserted] = yield* Effect.orDie(
          sql.rows(
            VersionRow,
            `INSERT INTO ky_soul_versions (key, version, action, actor, conversation, body, created_at)
             VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM ky_soul_versions WHERE key = ?), ?, ?, ?, ?, ?) RETURNING version`,
            file.key,
            file.key,
            action,
            actor,
            conversation,
            body,
            now
          )
        );

        return inserted?.version ?? 0;
      });

      const latest = Effect.fn("Versions.latest")(function* (file: VersionedFile) {
        const [newest] = yield* versions(file, 1);
        const found = newest ?? (yield* versions(file))[0];

        if (found !== undefined || file.template === undefined) return found;
        yield* insert(file, "create", "template", null, file.template);

        return (yield* versions(file, 1))[0];
      });

      const history = Effect.fn("Versions.history")(function* (file: VersionedFile) {
        yield* latest(file);

        return yield* versions(file);
      });

      const reverted = Effect.fn("Versions.reverted")(function* (file: VersionedFile, version: number) {
        const found = (yield* history(file)).find((each) => each.id === version);

        return found?.body ?? (yield* new NoVersion({ label: file.label, version }));
      });

      const next = Effect.fn("Versions.next")(function* (file: VersionedFile, change: SoulChange, was: string) {
        switch (change.action) {
          case "edit":
            return change.body ?? (yield* new Incomplete({ action: "edit" }));
          case "patch":
            return change.old === undefined || change.new === undefined ? yield* new Incomplete({ action: "patch" }) : yield* patched(file.label, was, change.old, change.new);
          case "revert":
            return change.version === undefined ? yield* new Incomplete({ action: "revert" }) : yield* reverted(file, change.version);
        }
      });

      return Versions.of({
        current: Effect.fn("Versions.current")(function* (file) {
          return (yield* latest(file)) ?? (yield* new Missing({ label: file.label }));
        }),
        history,
        apply: Effect.fn("Versions.apply")(function* (file, change, actor, conversation) {
          const found = yield* latest(file);

          if (found === undefined && change.action !== "edit") return yield* new Missing({ label: file.label });
          const was = found?.body ?? "";
          const body = yield* Effect.flatMap(next(file, change, was), (proposed) => checked(file.label, proposed));

          if (body === was) return `${file.label} is unchanged.`;
          const action = found ? change.action : "create";
          const version = yield* insert(file, action, actor, conversation, body);

          for (const listener of file.listeners) listener();

          return `Saved ${action} of ${file.label} (version ${version}).`;
        })
      });
    })
  );
}

const thrown = <A, E extends Refusable>(effect: Effect.Effect<A, E, Versions>) => Effect.catch(effect, ({ refusal }) => Effect.die(new Error(refusal)));

export class Versioned {
  readonly #edge: Edge<Versions>;
  readonly #file: VersionedFile;
  readonly #listeners: Set<() => void>;

  constructor(edge: Edge<Versions>, key: string, label: string, { template, listeners = new Set() }: { readonly template?: string; readonly listeners?: Set<() => void> } = {}) {
    this.#edge = edge;
    this.#listeners = listeners;
    this.#file = { key, label, template, listeners };
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  current(): SoulVersion {
    return this.#edge.run(thrown(Versions.use((versions) => versions.current(this.#file))));
  }

  view(): SoulView {
    const { body, id, created_at } = this.current();

    return { body, version: id, updated_at: created_at };
  }

  history(): SoulVersion[] {
    return this.#edge.run(Versions.use((versions) => versions.history(this.#file)));
  }

  apply(change: SoulChange, actor: string, conversation: string | null = null): string {
    return this.#edge.run(thrown(Versions.use((versions) => versions.apply(this.#file, change, actor, conversation))));
  }
}

export const versionLine = (each: SoulVersion) => `v${each.id} ${new Date(each.created_at).toISOString()} ${each.action} by ${each.actor}`;
