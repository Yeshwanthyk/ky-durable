import { defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge } from "../core/edge";
import { Sql } from "../core/sql";
import { CHAT_TABLES, ChatRow, type Opener } from "./contract";

const TITLE_CHARS = 60;

function titleOf(text: string): string {
  const line = text.trim().split("\n").find((part) => part.trim() !== "")?.trim() ?? "";

  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

const Column = Schema.Struct({ name: Schema.String });

const SessionOf = Schema.Struct({ session: Schema.String });

const OpenedBy = Schema.Struct({ opened_by: Schema.NullOr(Schema.String) });

const MainRow = Schema.Struct({ updated_at: Schema.Number });

interface ChatStore {
  readonly list: Effect.Effect<ReadonlyArray<ChatRow>>;
  readonly mainUpdatedAt: Effect.Effect<number>;
  readonly has: (session: string) => Effect.Effect<boolean>;
  readonly add: (session: string, opener?: Opener) => Effect.Effect<void>;
  readonly openedFor: (request: string) => Effect.Effect<string | undefined>;
  readonly openedBy: (session: string) => Effect.Effect<string | null>;
  readonly touch: (session: string, text: string) => Effect.Effect<boolean>;
  readonly answered: (session: string) => Effect.Effect<boolean>;
  readonly retitle: (session: string, was: string, title: string) => Effect.Effect<boolean>;
  readonly rename: (session: string, title: string) => Effect.Effect<boolean>;
  readonly archive: (session: string, archived: boolean) => Effect.Effect<boolean>;
}

export class Chats extends Context.Service<Chats, ChatStore>()("ky/chats/Chats") {
  static readonly layer = Layer.effect(Chats)(
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
      const rows = <T>(row: Schema.Decoder<T>, query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.rows(row, query, ...params));
      const first = <T>(row: Schema.Decoder<T>, query: string, ...params: SqlStorageValue[]) =>
        Effect.map(exec(query, ...params), ([found]) => Option.getOrUndefined(Schema.decodeUnknownOption(row)(found)));
      const written = (query: string, ...params: SqlStorageValue[]) => Effect.map(exec(`${query} RETURNING session`, ...params), (each) => each.length > 0);

      yield* exec(`CREATE TABLE IF NOT EXISTS ${CHAT_TABLES.chats} (
      session TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);
      const columns = yield* rows(Column, `PRAGMA table_info(${CHAT_TABLES.chats})`);

      if (!columns.some((column) => column.name === "archived_at")) yield* exec(`ALTER TABLE ${CHAT_TABLES.chats} ADD COLUMN archived_at INTEGER`);

      if (!columns.some((column) => column.name === "opened_by")) {
        yield* exec(`ALTER TABLE ${CHAT_TABLES.chats} ADD COLUMN opened_by TEXT`);
        yield* exec(`ALTER TABLE ${CHAT_TABLES.chats} ADD COLUMN opened_request TEXT`);
      }

      yield* exec(`CREATE TABLE IF NOT EXISTS ${CHAT_TABLES.main} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      updated_at INTEGER NOT NULL)`);

      return {
        list: rows(ChatRow, `SELECT * FROM ${CHAT_TABLES.chats} ORDER BY updated_at DESC`),
        mainUpdatedAt: Effect.map(rows(MainRow, `SELECT updated_at FROM ${CHAT_TABLES.main}`), ([row]) => row?.updated_at ?? 0),
        has: (session) => Effect.map(exec(`SELECT 1 FROM ${CHAT_TABLES.chats} WHERE session = ?`, session), (found) => found.length > 0),
        add: (session, opener) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;

            yield* exec(
              `INSERT OR IGNORE INTO ${CHAT_TABLES.chats} (session, created_at, updated_at, opened_by, opened_request) VALUES (?, ?, ?, ?, ?)`,
              session,
              now,
              now,
              opener?.by ?? null,
              opener?.request ?? null
            );
          }),
        openedFor: (request) => Effect.map(first(SessionOf, `SELECT session FROM ${CHAT_TABLES.chats} WHERE opened_request = ?`, request), (row) => row?.session),
        openedBy: (session) => Effect.map(first(OpenedBy, `SELECT opened_by FROM ${CHAT_TABLES.chats} WHERE session = ?`, session), (row) => row?.opened_by ?? null),
        touch: (session, text) =>
          Effect.gen(function* () {
            const unnamed = (yield* exec(`SELECT 1 FROM ${CHAT_TABLES.chats} WHERE session = ? AND title = ''`, session)).length > 0;

            yield* exec(
              `UPDATE ${CHAT_TABLES.chats} SET updated_at = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE session = ?`,
              yield* Clock.currentTimeMillis,
              titleOf(text),
              session
            );

            return unnamed && titleOf(text) !== "";
          }),
        answered: (session) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;

            if (session !== ROOT_SESSION) return yield* written(`UPDATE ${CHAT_TABLES.chats} SET updated_at = ? WHERE session = ?`, now, session);
            yield* exec(`INSERT OR REPLACE INTO ${CHAT_TABLES.main} (id, updated_at) VALUES (1, ?)`, now);

            return true;
          }),
        retitle: (session, was, title) => written(`UPDATE ${CHAT_TABLES.chats} SET title = ? WHERE session = ? AND title = ?`, title, session, was),
        rename: (session, title) => {
          const name = titleOf(title);

          return name === "" ? Effect.succeed(false) : written(`UPDATE ${CHAT_TABLES.chats} SET title = ? WHERE session = ?`, name, session);
        },
        archive: (session, archived) =>
          Effect.gen(function* () {
            return yield* written(`UPDATE ${CHAT_TABLES.chats} SET archived_at = ? WHERE session = ?`, archived ? yield* Clock.currentTimeMillis : null, session);
          })
      };
    })
  );
}

export class ChatList {
  readonly #edge: Edge<Chats>;
  readonly #listeners = new Set<() => void>();
  readonly #namers = new Set<(session: string, text: string) => void>();

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(Chats.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#run(() => Effect.void);
  }

  #run<A>(action: (chats: Chats["Service"]) => Effect.Effect<A>): A {
    return this.#edge.run(Chats.use(action));
  }

  #emit(changed = true): void {
    if (changed) for (const listener of this.#listeners) listener();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  onNamed(listener: (session: string, text: string) => void): () => void {
    this.#namers.add(listener);

    return () => this.#namers.delete(listener);
  }

  list(): ReadonlyArray<ChatRow> {
    return this.#run((chats) => chats.list);
  }

  mainUpdatedAt(): number {
    return this.#run((chats) => chats.mainUpdatedAt);
  }

  has(session: string): boolean {
    return this.#run((chats) => chats.has(session));
  }

  add(session: string, opener?: Opener): void {
    this.#run((chats) => chats.add(session, opener));
    this.#emit();
  }

  openedFor(request: string): string | undefined {
    return this.#run((chats) => chats.openedFor(request));
  }

  openedBy(session: string): string | null {
    return this.#run((chats) => chats.openedBy(session));
  }

  touch(session: string, text: string): void {
    const named = this.#run((chats) => chats.touch(session, text));
    this.#emit();

    if (named) for (const namer of this.#namers) namer(session, text);
  }

  answered(session: string): void {
    this.#emit(this.#run((chats) => chats.answered(session)));
  }

  retitle(session: string, was: string, title: string): void {
    this.#emit(this.#run((chats) => chats.retitle(session, was, title)));
  }

  rename(session: string, title: string): void {
    this.#emit(this.#run((chats) => chats.rename(session, title)));
  }

  archive(session: string, archived: boolean): void {
    this.#emit(this.#run((chats) => chats.archive(session, archived)));
  }
}

export function chatActivityExtension(chats: ChatList): Extension {
  return defineExtension({
    name: "chat-activity",
    hooks: [
      hook(GenerationTask, {
        onYield(_answer, api) {
          chats.answered(String(api.conversationId));

          return undefined;
        }
      })
    ]
  });
}
