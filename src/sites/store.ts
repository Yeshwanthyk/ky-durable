import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Sql } from "../core/sql";
import {
  BadDataName,
  COLLECTION,
  EDIT_BATCH_MS,
  ITEM_KEY,
  ItemTooBig,
  LinkMode,
  MAX_COLLECTIONS,
  MAX_ITEM_BYTES,
  MAX_ITEMS,
  MAX_LINKS,
  NoLink,
  RouteMode,
  SITE_TABLES,
  type SiteItem,
  type SiteLink,
  type SiteVersion,
  TooManyCollections,
  TooManyItems,
  TooManyLinks
} from "./contract";

const { sites: SITES, links: LINKS, items: ITEMS, edits: EDITS } = SITE_TABLES;

const KEPT_EDITS = 200;

const LINE_CHARS = 400;

const SiteStateRow = Schema.Struct({ session: Schema.NullOr(Schema.String), published: Schema.Number, data: Schema.Number });

const LinkRow = Schema.Struct({ token: Schema.String, site: Schema.String, label: Schema.String, mode: RouteMode, revoked: Schema.Number, created_at: Schema.Number });

type LinkRow = typeof LinkRow.Type;

const ItemRow = Schema.Struct({ key: Schema.String, value: Schema.fromJsonString(Schema.Json), updated_at: Schema.Number });

const CollectionRow = Schema.Struct({ name: Schema.String, count: Schema.Number });

const EditRow = Schema.Struct({ id: Schema.Number, site: Schema.String, line: Schema.String, collection: Schema.String, at: Schema.Number });

const Count = Schema.Struct({ count: Schema.Number });

const Oldest = Schema.Struct({ at: Schema.NullOr(Schema.Number) });

const isLinkMode = Schema.is(LinkMode);

/** Who wrote: ky itself, the owner signed in or through their page, or a person through a share link, whose writes ky is told. */
export type Editor = { readonly kind: "ky" } | { readonly kind: "owner" } | { readonly kind: "link"; readonly label: string };

export type Batch = { readonly site: string; readonly lines: ReadonlyArray<string>; readonly collections: ReadonlyArray<string>; readonly last: number };

type Written<A> = A & { readonly version: number; readonly book: boolean };

const itemOf = (row: typeof ItemRow.Type): SiteItem => ({ key: row.key, value: row.value, updated: row.updated_at });

const linkOf = (row: LinkRow): SiteLink | undefined =>
  isLinkMode(row.mode) ? { token: row.token, label: row.label, mode: row.mode, created: row.created_at, revoked: row.revoked === 1 } : undefined;

const plain = (text: string) => text.replace(/[[\]\r\n]/g, " ").replace(/\s+/g, " ").trim();

const clip = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

const named = (collection: string, key?: string) =>
  Effect.gen(function* () {
    if (!COLLECTION.test(collection)) return yield* new BadDataName({ what: "collection", name: collection });

    if (key !== undefined && !ITEM_KEY.test(key)) return yield* new BadDataName({ what: "key", name: key });
  });

export class SiteStore extends Context.Service<
  SiteStore,
  {
    published(site: string, session: string | null): Effect.Effect<void>;
    version(site: string): Effect.Effect<SiteVersion>;
    session(site: string): Effect.Effect<string | null>;
    link(token: string): Effect.Effect<LinkRow | undefined>;
    links(site: string): Effect.Effect<ReadonlyArray<SiteLink>>;
    tokens(site: string): Effect.Effect<ReadonlyArray<string>>;
    owner(site: string): Effect.Effect<string | undefined>;
    addLink(site: string, token: string, label: string, mode: RouteMode, created?: number): Effect.Effect<LinkRow, TooManyLinks>;
    revoke(site: string, token: string): Effect.Effect<void, NoLink>;
    collections(site: string): Effect.Effect<ReadonlyArray<typeof CollectionRow.Type>>;
    items(site: string, collection: string): Effect.Effect<ReadonlyArray<SiteItem>, BadDataName>;
    item(site: string, collection: string, key: string): Effect.Effect<SiteItem | undefined, BadDataName>;
    put(site: string, collection: string, key: string, value: Schema.Json, by: Editor): Effect.Effect<Written<{ item: SiteItem }>, BadDataName | ItemTooBig | TooManyItems | TooManyCollections>;
    remove(site: string, collection: string, key: string, by: Editor): Effect.Effect<Written<{ removed: boolean }>, BadDataName>;
    readonly batches: Effect.Effect<ReadonlyArray<Batch>>;
    told(site: string, last: number): Effect.Effect<void>;
    forget(site: string): Effect.Effect<void>;
  }
>()("ky/sites/SiteStore") {
  static readonly layer = Layer.effect(
    SiteStore,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
      const rows = <T>(row: Schema.Decoder<T>, query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.rows(row, query, ...params));
      const count = (query: string, ...params: SqlStorageValue[]) => Effect.map(rows(Count, query, ...params), ([found]) => found?.count ?? 0);
      const state = (site: string) => Effect.map(rows(SiteStateRow, `SELECT session, published, data FROM ${SITES} WHERE site = ?`, site), ([found]) => found);
      const link = (token: string) => Effect.map(rows(LinkRow, `SELECT * FROM ${LINKS} WHERE token = ?`, token), ([found]) => found);
      const live = (site: string) => rows(LinkRow, `SELECT * FROM ${LINKS} WHERE site = ? AND revoked = 0 ORDER BY created_at, token`, site);

      const item = (site: string, collection: string, key: string) =>
        Effect.map(rows(ItemRow, `SELECT key, value, updated_at FROM ${ITEMS} WHERE site = ? AND collection = ? AND key = ?`, site, collection, key), ([found]) => found && itemOf(found));

      const bumped = (site: string) =>
        Effect.gen(function* () {
          yield* exec(`INSERT INTO ${SITES} (site, published, data) VALUES (?, 0, 1) ON CONFLICT (site) DO UPDATE SET data = data + 1`, site);

          return (yield* state(site))?.data ?? 0;
        });

      const edited = (site: string, collection: string, line: string, by: Editor) =>
        Effect.gen(function* () {
          if (by.kind !== "link") return false;
          const now = yield* Clock.currentTimeMillis;
          // The first edit since ky was last told books the telling; so does one long past it, if that telling was lost.
          const [oldest] = yield* rows(Oldest, `SELECT MIN(at) AS at FROM ${EDITS}`);
          const book = oldest?.at == null || oldest.at < now - 2 * EDIT_BATCH_MS;

          yield* exec(`INSERT INTO ${EDITS} (site, line, collection, at) VALUES (?, ?, ?, ?)`, site, `${plain(by.label) || "Someone"} ${line}`, collection, now);
          yield* exec(`DELETE FROM ${EDITS} WHERE site = ? AND id NOT IN (SELECT id FROM ${EDITS} WHERE site = ? ORDER BY id DESC LIMIT ?)`, site, site, KEPT_EDITS);

          return book;
        });

      yield* exec(`CREATE TABLE IF NOT EXISTS ${SITES} (
      site TEXT PRIMARY KEY,
      session TEXT,
      published INTEGER NOT NULL,
      data INTEGER NOT NULL)`);
      yield* exec(`CREATE TABLE IF NOT EXISTS ${LINKS} (
      token TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      label TEXT NOT NULL,
      mode TEXT NOT NULL,
      revoked INTEGER NOT NULL,
      created_at INTEGER NOT NULL)`);
      yield* exec(`CREATE INDEX IF NOT EXISTS ${LINKS}_site ON ${LINKS} (site)`);
      yield* exec(`CREATE TABLE IF NOT EXISTS ${ITEMS} (
      site TEXT NOT NULL,
      collection TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (site, collection, key))`);
      yield* exec(`CREATE TABLE IF NOT EXISTS ${EDITS} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site TEXT NOT NULL,
      line TEXT NOT NULL,
      collection TEXT NOT NULL,
      at INTEGER NOT NULL)`);

      return SiteStore.of({
        published: Effect.fnUntraced(function* (site, session) {
          yield* exec(
            `INSERT INTO ${SITES} (site, session, published, data) VALUES (?, ?, 1, 0) ON CONFLICT (site) DO UPDATE SET published = published + 1, session = COALESCE(excluded.session, session)`,
            site,
            session
          );
        }),
        version: (site) => Effect.map(state(site), (found) => ({ published: found?.published ?? 0, data: found?.data ?? 0 })),
        session: (site) => Effect.map(state(site), (found) => found?.session ?? null),
        link,
        links: (site) => Effect.map(live(site), (found) => found.flatMap((row) => linkOf(row) ?? [])),
        tokens: (site) => Effect.map(rows(LinkRow, `SELECT * FROM ${LINKS} WHERE site = ?`, site), (found) => found.map((row) => row.token)),
        owner: (site) => Effect.map(live(site), (found) => found.find((row) => row.mode === "owner")?.token),
        addLink: Effect.fnUntraced(function* (site, token, label, mode, created) {
          if (mode !== "owner" && created === undefined && (yield* live(site)).filter((row) => row.mode !== "owner").length >= MAX_LINKS) return yield* new TooManyLinks();
          const row: LinkRow = { token, site, label: clip(plain(label), 80), mode, revoked: 0, created_at: created ?? (yield* Clock.currentTimeMillis) };

          yield* exec(`INSERT OR IGNORE INTO ${LINKS} (token, site, label, mode, revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)`, token, site, row.label, mode, row.created_at);

          return row;
        }),
        revoke: Effect.fnUntraced(function* (site, token) {
          const done = yield* exec(`UPDATE ${LINKS} SET revoked = 1 WHERE token = ? AND site = ? AND revoked = 0 AND mode != 'owner' RETURNING token`, token, site);

          if (done.length === 0) return yield* new NoLink({ token });
        }),
        collections: (site) => rows(CollectionRow, `SELECT collection AS name, COUNT(*) AS count FROM ${ITEMS} WHERE site = ? GROUP BY collection ORDER BY collection`, site),
        items: Effect.fnUntraced(function* (site, collection) {
          yield* named(collection);

          return (yield* rows(ItemRow, `SELECT key, value, updated_at FROM ${ITEMS} WHERE site = ? AND collection = ? ORDER BY updated_at, key`, site, collection)).map(itemOf);
        }),
        item: Effect.fnUntraced(function* (site, collection, key) {
          yield* named(collection, key);

          return yield* item(site, collection, key);
        }),
        put: Effect.fnUntraced(function* (site, collection, key, value, by) {
          yield* named(collection, key);
          const text = JSON.stringify(value);
          const bytes = new TextEncoder().encode(text).byteLength;

          if (bytes > MAX_ITEM_BYTES) return yield* new ItemTooBig({ bytes });
          const before = yield* item(site, collection, key);

          if (before === undefined) {
            const held = yield* count(`SELECT COUNT(*) AS count FROM ${ITEMS} WHERE site = ? AND collection = ?`, site, collection);

            if (held >= MAX_ITEMS) return yield* new TooManyItems({ collection });

            if (held === 0 && (yield* count(`SELECT COUNT(DISTINCT collection) AS count FROM ${ITEMS} WHERE site = ?`, site)) >= MAX_COLLECTIONS) {
              return yield* new TooManyCollections();
            }
          }

          const now = yield* Clock.currentTimeMillis;

          yield* exec(`INSERT OR REPLACE INTO ${ITEMS} (site, collection, key, value, updated_at) VALUES (?, ?, ?, ?, ?)`, site, collection, key, text, now);
          const book = yield* edited(site, collection, `${before ? "changed" : "added"} ${collection}/${key}: ${clip(text, LINE_CHARS)}`, by);

          return { item: { key, value, updated: now }, version: yield* bumped(site), book };
        }),
        remove: Effect.fnUntraced(function* (site, collection, key, by) {
          yield* named(collection, key);
          const removed = (yield* exec(`DELETE FROM ${ITEMS} WHERE site = ? AND collection = ? AND key = ? RETURNING key`, site, collection, key)).length > 0;

          if (!removed) return { removed, version: (yield* state(site))?.data ?? 0, book: false };
          const book = yield* edited(site, collection, `removed ${collection}/${key}`, by);

          return { removed, version: yield* bumped(site), book };
        }),
        batches: Effect.map(rows(EditRow, `SELECT * FROM ${EDITS} ORDER BY id`), (edits) => {
          const by = new Map<string, { lines: string[]; collections: Set<string>; last: number }>();

          for (const edit of edits) {
            const batch = by.get(edit.site) ?? { lines: [], collections: new Set<string>(), last: 0 };
            batch.lines.push(edit.line);
            batch.collections.add(edit.collection);
            batch.last = edit.id;
            by.set(edit.site, batch);
          }

          return [...by].map(([site, batch]) => ({ site, lines: batch.lines, collections: [...batch.collections], last: batch.last }));
        }),
        told: Effect.fnUntraced(function* (site, last) {
          yield* exec(`DELETE FROM ${EDITS} WHERE site = ? AND id <= ?`, site, last);
        }),
        forget: Effect.fnUntraced(function* (site) {
          for (const table of [LINKS, ITEMS, EDITS, SITES]) yield* exec(`DELETE FROM ${table} WHERE site = ?`, site);
        })
      });
    })
  );
}
