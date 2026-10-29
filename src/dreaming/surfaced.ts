import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge, type Refusable, runOrThrow } from "../core/edge";
import { Sql } from "../core/sql";
import { ShownItem, SurfacedOutcome } from "./contract";

export type SurfacedKind = "event" | "look" | "post" | "recall";

export type Shown = {
  readonly kind: SurfacedKind;
  readonly ref: string;
  readonly item: string;
  readonly text: string;
  readonly expiresAt: number;
};

const KEEP_MS = 60 * 86_400_000;

const SurfacedRow = Schema.Struct({
  id: Schema.Int,
  kind: Schema.String,
  loop: Schema.String,
  ref: Schema.String,
  ...ShownItem.fields,
  shown_at: Schema.Number,
  expires_at: Schema.Number,
  outcome: Schema.NullOr(SurfacedOutcome),
  outcome_at: Schema.NullOr(Schema.Number)
});

const decodeRefShown = Schema.decodeUnknownOption(
  Schema.Struct({
    ref: SurfacedRow.fields.ref,
    at: SurfacedRow.fields.shown_at
  })
);

const decodeShownItem = Schema.decodeUnknownOption(ShownItem);

const decodeOutcome = Schema.decodeUnknownOption(Schema.Struct({ outcome: SurfacedRow.fields.outcome }));

class NothingShown
  extends Schema.TaggedError<NothingShown>()("NothingShown", {
    item: Schema.String
  })
  implements Refusable
{
  get refusal(): string {
    return `Nothing shown as ${this.item}.`;
  }
}

class AlreadyOver
  extends Schema.TaggedError<AlreadyOver>()("AlreadyOver", {
    item: Schema.String,
    was: SurfacedOutcome
  })
  implements Refusable
{
  get refusal(): string {
    return `${this.item} is ${this.was} already.`;
  }
}

const nowOr = (now: number | undefined) => (now === undefined ? Clock.currentTimeMillis : Effect.succeed(now));

export class SurfacedStore extends Context.Service<
  SurfacedStore,
  {
    readonly prune: (now: number | undefined) => Effect.Effect<number>;
    readonly shown: (entry: Shown, now: number | undefined) => Effect.Effect<void>;
    readonly outcomeOf: (kind: SurfacedKind, item: string) => Effect.Effect<SurfacedOutcome | null | undefined>;
    readonly outcome: (kind: SurfacedKind, item: string, outcome: SurfacedOutcome, now: number | undefined) => Effect.Effect<void, NothingShown | AlreadyOver>;
    readonly items: (kind: SurfacedKind, prefix: string, from: number, limit: number) => Effect.Effect<ShownItem[]>;
    readonly lastShown: (kind: SurfacedKind) => Effect.Effect<Map<string, number>>;
    readonly expire: (now: number | undefined) => Effect.Effect<number>;
  }
>()("ky/dreaming/Surfaced") {
  static readonly layer = Layer.effect(
    SurfacedStore,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));

      yield* exec(`CREATE TABLE IF NOT EXISTS ky_surfaced (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        loop TEXT NOT NULL,
        ref TEXT NOT NULL,
        item TEXT NOT NULL,
        text TEXT NOT NULL,
        shown_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        outcome TEXT,
        outcome_at INTEGER,
        UNIQUE (kind, item))`);
      yield* exec("CREATE INDEX IF NOT EXISTS ky_surfaced_open ON ky_surfaced (outcome, expires_at)");

      const expire = Effect.fn("Surfaced.expire")(function* (at: number | undefined) {
        const now = yield* nowOr(at);

        return (yield* exec("UPDATE ky_surfaced SET outcome = 'expired', outcome_at = expires_at WHERE outcome IS NULL AND expires_at <= ? RETURNING id", now)).length;
      });

      const outcomeOf = Effect.fn("Surfaced.outcomeOf")(function* (kind: SurfacedKind, item: string) {
        const [row] = yield* exec("SELECT outcome FROM ky_surfaced WHERE kind = ? AND item = ?", kind, item);

        if (row === undefined) return undefined;

        return Option.getOrNull(Option.map(decodeOutcome(row), ({ outcome }) => outcome));
      });

      return SurfacedStore.of({
        prune: Effect.fn("Surfaced.prune")(function* (at) {
          const now = yield* nowOr(at);

          return (yield* exec("DELETE FROM ky_surfaced WHERE outcome IS NOT NULL AND outcome_at < ? RETURNING id", now - KEEP_MS)).length;
        }),
        shown: Effect.fn("Surfaced.shown")(function* (entry, at) {
          const now = yield* nowOr(at);
          yield* exec(
            "INSERT INTO ky_surfaced (kind, loop, ref, item, text, shown_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, item) DO NOTHING",
            entry.kind,
            entry.kind,
            entry.ref,
            entry.item,
            entry.text,
            now,
            entry.expiresAt
          );
        }),
        outcomeOf,
        outcome: Effect.fn("Surfaced.outcome")(function* (kind, item, outcome, at) {
          const now = yield* nowOr(at);
          yield* expire(now);
          const was = yield* outcomeOf(kind, item);

          if (was === undefined) return yield* new NothingShown({ item });

          if (was !== null) return yield* new AlreadyOver({ item, was });
          yield* exec("UPDATE ky_surfaced SET outcome = ?, outcome_at = ? WHERE kind = ? AND item = ?", outcome, now, kind, item);
        }),
        items: (kind, prefix, from, limit) =>
          Effect.map(
            exec(
              "SELECT item, text FROM ky_surfaced WHERE kind = ? AND item >= ? AND item < ? AND shown_at >= ? ORDER BY shown_at DESC, id DESC LIMIT ?",
              kind,
              prefix,
              `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`,
              from,
              limit
            ),
            (rows) => rows.flatMap((row) => Option.toArray(decodeShownItem(row)))
          ),
        lastShown: (kind) =>
          Effect.map(
            exec("SELECT ref, max(shown_at) AS at FROM ky_surfaced WHERE kind = ? GROUP BY ref", kind),
            (rows) => new Map(rows.flatMap((row) => Option.toArray(decodeRefShown(row))).map((row) => [row.ref, row.at]))
          ),
        expire
      });
    })
  );
}

export class Surfaced {
  readonly #edge: Edge<SurfacedStore>;

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(SurfacedStore.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  prune(now?: number): number {
    return this.#edge.run(SurfacedStore.use((store) => store.prune(now)));
  }

  shown(entry: Shown, now?: number): void {
    this.#edge.run(SurfacedStore.use((store) => store.shown(entry, now)));
  }

  outcomeOf(kind: SurfacedKind, item: string): SurfacedOutcome | null | undefined {
    return this.#edge.run(SurfacedStore.use((store) => store.outcomeOf(kind, item)));
  }

  outcome(kind: SurfacedKind, item: string, outcome: SurfacedOutcome, now?: number): void {
    runOrThrow(
      this.#edge,
      SurfacedStore.use((store) => store.outcome(kind, item, outcome, now))
    );
  }

  items(kind: SurfacedKind, prefix: string, from: number, limit: number): ShownItem[] {
    return this.#edge.run(SurfacedStore.use((store) => store.items(kind, prefix, from, limit)));
  }

  lastShown(kind: SurfacedKind): Map<string, number> {
    return this.#edge.run(SurfacedStore.use((store) => store.lastShown(kind)));
  }

  expire(now?: number): number {
    return this.#edge.run(SurfacedStore.use((store) => store.expire(now)));
  }
}
