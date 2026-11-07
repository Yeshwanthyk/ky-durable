import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge } from "../core/edge";
import { Sql } from "../core/sql";
import type { Trigger } from "./pace";

/** Events kept after a look took them, for the Desk. */
const KEEP_MS = 7 * 86_400_000;

const LINE_CHARS = 400;

const DAY_MS = 86_400_000;

const LookEvent = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  line: Schema.String,
  at: Schema.Number,
  look: Schema.NullOr(Schema.String)
});

export type LookEvent = typeof LookEvent.Type;

const decodeEvent = Schema.decodeUnknownOption(LookEvent);

const Start = Schema.Struct({
  id: Schema.String,
  ref: Schema.String,
  session: Schema.String,
  title: Schema.String,
  at: Schema.Number,
  verdict: Schema.NullOr(Schema.Literals(["kept", "discarded"]))
});

export type Start = typeof Start.Type;

const decodeStart = Schema.decodeUnknownOption(Start);

const LastRun = Schema.Struct({ fingerprint: Schema.String });

const decodeLast = Schema.decodeUnknownOption(LastRun);

const Count = Schema.Struct({ n: Schema.Number });

const decodeCount = Schema.decodeUnknownOption(Count);

/**
 * What woke ky between looks (a mail it triaged), each kept once by its id until one look takes it, and every look
 * that asked the model, with what it read (docs/research/proactivity/night-shift-model.md, invariants 1 and 3).
 */
class EventStore extends Context.Service<
  EventStore,
  {
    readonly add: (id: string, kind: string, line: string, at: number) => Effect.Effect<boolean>;
    readonly waiting: Effect.Effect<LookEvent[]>;
    readonly claim: (look: string) => Effect.Effect<LookEvent[]>;
    readonly release: (look: string) => Effect.Effect<void>;
    readonly recent: (since: number) => Effect.Effect<LookEvent[]>;
    readonly ran: (look: string, trigger: Trigger, fingerprint: string, at: number) => Effect.Effect<void>;
    readonly last: Effect.Effect<string | null>;
    readonly extraSince: (since: number) => Effect.Effect<number>;
    readonly started: (start: Omit<Start, "verdict">) => Effect.Effect<void>;
    readonly starts: (since: number) => Effect.Effect<Start[]>;
    readonly judge: (id: string, verdict: "kept" | "discarded") => Effect.Effect<Start | undefined>;
  }
>()("ky/dreaming/LookEvents") {
  static readonly layer = Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
      const events = (query: string, ...params: SqlStorageValue[]) => Effect.map(exec(query, ...params), (rows) => rows.flatMap((row) => Option.toArray(decodeEvent(row))));

      yield* exec(`CREATE TABLE IF NOT EXISTS ky_look_events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        line TEXT NOT NULL,
        at INTEGER NOT NULL,
        look TEXT)`);
      yield* exec(`CREATE TABLE IF NOT EXISTS ky_look_runs (
        look TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        at INTEGER NOT NULL)`);
      yield* exec(`CREATE TABLE IF NOT EXISTS ky_starts (
        id TEXT PRIMARY KEY,
        ref TEXT NOT NULL,
        session TEXT NOT NULL,
        title TEXT NOT NULL,
        at INTEGER NOT NULL,
        verdict TEXT)`);
      const starts = (query: string, ...params: SqlStorageValue[]) => Effect.map(exec(query, ...params), (rows) => rows.flatMap((row) => Option.toArray(decodeStart(row))));

      return EventStore.of({
        add: Effect.fn("LookEvents.add")(function* (id, kind, line, at) {
          yield* exec("DELETE FROM ky_look_events WHERE look IS NOT NULL AND at < ?", at - KEEP_MS);
          yield* exec("DELETE FROM ky_look_runs WHERE at < ?", at - KEEP_MS);
          const before = (yield* exec("SELECT 1 FROM ky_look_events WHERE id = ?", id)).length;
          yield* exec("INSERT OR IGNORE INTO ky_look_events (id, kind, line, at, look) VALUES (?, ?, ?, ?, NULL)", id, kind, line.slice(0, LINE_CHARS), at);

          return before === 0;
        }),
        waiting: events("SELECT id, kind, line, at, look FROM ky_look_events WHERE look IS NULL ORDER BY at, id"),
        // One statement takes what waits and what a run left when ky restarted mid-look (it claimed, then never
        // recorded ran, so it never posted). Only one look runs at a time (`looking` in Looks.run), so a run with no
        // ky_look_runs row is a dead one (verify-formal-looks, NoneStranded).
        claim: (look) =>
          Effect.andThen(exec("UPDATE ky_look_events SET look = ? WHERE look IS NULL OR look NOT IN (SELECT look FROM ky_look_runs)", look), events("SELECT id, kind, line, at, look FROM ky_look_events WHERE look = ? ORDER BY at, id", look)),
        release: (look) => Effect.asVoid(exec("UPDATE ky_look_events SET look = NULL WHERE look = ?", look)),
        recent: (since) => events("SELECT id, kind, line, at, look FROM ky_look_events WHERE at >= ? ORDER BY at DESC, id", since),
        ran: (look, trigger, fingerprint, at) => Effect.asVoid(exec("INSERT OR REPLACE INTO ky_look_runs (look, trigger, fingerprint, at) VALUES (?, ?, ?, ?)", look, trigger, fingerprint, at)),
        last: Effect.map(exec("SELECT fingerprint FROM ky_look_runs ORDER BY at DESC, rowid DESC LIMIT 1"), ([row]) =>
          Option.getOrNull(Option.map(decodeLast(row), (stored) => stored.fingerprint))
        ),
        extraSince: (since) =>
          Effect.map(exec("SELECT COUNT(*) AS n FROM ky_look_runs WHERE trigger != 'look' AND at >= ?", since), ([row]) =>
            Option.getOrElse(
              Option.map(decodeCount(row), ({ n }) => n),
              () => 0
            )
          ),
        started: (start) => Effect.asVoid(exec("INSERT OR IGNORE INTO ky_starts (id, ref, session, title, at, verdict) VALUES (?, ?, ?, ?, ?, NULL)", start.id, start.ref, start.session, start.title, start.at)),
        starts: (since) => starts("SELECT id, ref, session, title, at, verdict FROM ky_starts WHERE at >= ? ORDER BY at DESC", since),
        judge: (id, verdict) =>
          Effect.andThen(exec("UPDATE ky_starts SET verdict = ? WHERE id = ? AND verdict IS NULL", verdict, id), Effect.map(starts("SELECT id, ref, session, title, at, verdict FROM ky_starts WHERE id = ?", id), ([start]) => start))
      });
    })
  );
}

export class LookEvents {
  readonly #edge: Edge<EventStore>;

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(EventStore.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  /** Keep an event for the next look; false when its id was kept already. */
  add(id: string, kind: string, line: string, at: number): boolean {
    return this.#edge.run(EventStore.use((store) => store.add(id, kind, line, at)));
  }

  waiting(): LookEvent[] {
    return this.#edge.run(EventStore.use((store) => store.waiting));
  }

  /** Give every waiting event to `look`; what it returns no other look gets. */
  claim(look: string): LookEvent[] {
    return this.#edge.run(EventStore.use((store) => store.claim(look)));
  }

  /** A look that failed gives back what it took. */
  release(look: string): void {
    this.#edge.run(EventStore.use((store) => store.release(look)));
  }

  recent(since: number): LookEvent[] {
    return this.#edge.run(EventStore.use((store) => store.recent(since)));
  }

  ran(look: string, trigger: Trigger, fingerprint: string, at: number): void {
    this.#edge.run(EventStore.use((store) => store.ran(look, trigger, fingerprint, at)));
  }

  /** What the last look that asked the model read, or null before the first. */
  last(): string | null {
    return this.#edge.run(EventStore.use((store) => store.last));
  }

  started(start: Omit<Start, "verdict">): void {
    this.#edge.run(EventStore.use((store) => store.started(start)));
  }

  /** What ky started since `since`, newest first. */
  starts(since: number): Start[] {
    return this.#edge.run(EventStore.use((store) => store.starts(since)));
  }

  /** The user keeps or discards a start, once. */
  judge(id: string, verdict: "kept" | "discarded"): Start | undefined {
    return this.#edge.run(EventStore.use((store) => store.judge(id, verdict)));
  }

  /** Heartbeat and event looks that asked the model in the day before `now`. */
  extraToday(now: number): number {
    return this.#edge.run(EventStore.use((store) => store.extraSince(now - DAY_MS)));
  }
}
