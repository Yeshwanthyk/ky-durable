import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge, type Refusable, runOrThrow } from "../core/edge";
import { Sql } from "../core/sql";
import { LOOK_TIME, LOOK_TIMES, type ProactivityLevel, type ProactivityView, RIGHT_AWAY_MOST } from "./contract";

const DEFAULT_LOOKS = ["08:00", "13:00", "18:00"];

const DEFAULT_RIGHT_AWAY = 6;

const ProactivityRow = Schema.Struct({
  id: Schema.Int,
  level: Schema.String,
  looks: Schema.fromJsonString(Schema.Array(Schema.String.check(Schema.isPattern(LOOK_TIME))).check(Schema.isMaxLength(LOOK_TIMES))),
  right_away: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: RIGHT_AWAY_MOST }))
});

const decodeLevel = Schema.decodeUnknownOption(Schema.Struct({ level: ProactivityRow.fields.level }));

const decodeLooks = Schema.decodeUnknownOption(Schema.Struct({ looks: ProactivityRow.fields.looks }));

const decodeRightAway = Schema.decodeUnknownOption(Schema.Struct({ right_away: ProactivityRow.fields.right_away }));

const ColumnRow = Schema.Struct({ name: Schema.String });

class NotATime extends Schema.TaggedError<NotATime>()("NotATime", {}) implements Refusable {
  get refusal(): string {
    return "A look time is HH:MM, like 08:00.";
  }
}

class TooManyLooks extends Schema.TaggedError<TooManyLooks>()("TooManyLooks", {}) implements Refusable {
  get refusal(): string {
    return `At most ${LOOK_TIMES} look times.`;
  }
}

class NotRightAway extends Schema.TaggedError<NotRightAway>()("NotRightAway", {}) implements Refusable {
  get refusal(): string {
    return `Right away is a whole number from 0 to ${RIGHT_AWAY_MOST}.`;
  }
}

export class ProactivityStore extends Context.Service<
  ProactivityStore,
  {
    readonly level: Effect.Effect<ProactivityLevel>;
    readonly looks: Effect.Effect<string[]>;
    readonly rightAway: Effect.Effect<number>;
    readonly set: (level: ProactivityLevel) => Effect.Effect<void>;
    readonly setLooks: (times: readonly string[]) => Effect.Effect<void, NotATime | TooManyLooks>;
    readonly setRightAway: (most: number) => Effect.Effect<void, NotRightAway>;
    readonly view: Effect.Effect<ProactivityView>;
  }
>()("ky/dreaming/Proactivity") {
  static readonly layer = Layer.effect(
    ProactivityStore,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
      const first = (query: string) => Effect.map(exec(query), ([row]) => row);

      yield* exec(`CREATE TABLE IF NOT EXISTS ky_proactivity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        level TEXT NOT NULL)`);

      const columns = (yield* Effect.orDie(sql.rows(ColumnRow, "PRAGMA table_info(ky_proactivity)"))).map((column) => column.name);

      if (!columns.includes("looks")) yield* exec("ALTER TABLE ky_proactivity ADD COLUMN looks TEXT");

      if (!columns.includes("right_away")) yield* exec("ALTER TABLE ky_proactivity ADD COLUMN right_away INTEGER");

      const level = Effect.map(first("SELECT level FROM ky_proactivity WHERE id = 1"), (row): ProactivityLevel => (Option.exists(decodeLevel(row), (stored) => stored.level === "off") ? "off" : "on"));

      const looks = Effect.map(first("SELECT looks FROM ky_proactivity WHERE id = 1"), (row) =>
        Option.getOrElse(
          Option.map(decodeLooks(row), (stored) => stored.looks.toSorted()),
          () => DEFAULT_LOOKS
        )
      );

      const rightAway = Effect.map(first("SELECT right_away FROM ky_proactivity WHERE id = 1"), (row) =>
        Option.getOrElse(
          Option.map(decodeRightAway(row), (stored) => stored.right_away),
          () => DEFAULT_RIGHT_AWAY
        )
      );

      return ProactivityStore.of({
        level,
        looks,
        rightAway,
        set: (to) => exec("INSERT INTO ky_proactivity (id, level) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET level = excluded.level", to),
        setLooks: Effect.fn("Proactivity.setLooks")(function* (times) {
          const sorted = [...new Set(times)].toSorted();

          if (sorted.some((time) => !LOOK_TIME.test(time))) return yield* new NotATime();

          if (sorted.length > LOOK_TIMES) return yield* new TooManyLooks();
          yield* exec("INSERT INTO ky_proactivity (id, level, looks) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET looks = excluded.looks", yield* level, JSON.stringify(sorted));
        }),
        setRightAway: Effect.fn("Proactivity.setRightAway")(function* (most) {
          if (!Number.isInteger(most) || most < 0 || most > RIGHT_AWAY_MOST) return yield* new NotRightAway();
          yield* exec("INSERT INTO ky_proactivity (id, level, right_away) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET right_away = excluded.right_away", yield* level, most);
        }),
        view: Effect.all({ level, looks, rightAway })
      });
    })
  );
}

export class Proactivity {
  readonly #edge: Edge<ProactivityStore>;
  readonly #listeners = new Set<() => void>();

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(ProactivityStore.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  onChange(listener: () => void): void {
    this.#listeners.add(listener);
  }

  level(): ProactivityLevel {
    return this.#edge.run(ProactivityStore.use((store) => store.level));
  }

  looks(): string[] {
    return this.#edge.run(ProactivityStore.use((store) => store.looks));
  }

  rightAway(): number {
    return this.#edge.run(ProactivityStore.use((store) => store.rightAway));
  }

  set(level: ProactivityLevel): ProactivityView {
    this.#edge.run(ProactivityStore.use((store) => store.set(level)));

    return this.#changed();
  }

  setLooks(times: readonly string[]): ProactivityView {
    runOrThrow(
      this.#edge,
      ProactivityStore.use((store) => store.setLooks(times))
    );

    return this.#changed();
  }

  setRightAway(most: number): ProactivityView {
    runOrThrow(
      this.#edge,
      ProactivityStore.use((store) => store.setRightAway(most))
    );

    return this.view();
  }

  view(): ProactivityView {
    return this.#edge.run(ProactivityStore.use((store) => store.view));
  }

  #changed(): ProactivityView {
    for (const listener of this.#listeners) listener();

    return this.view();
  }
}
