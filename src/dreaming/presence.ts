import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge } from "../core/edge";
import { Sql } from "../core/sql";

const PresenceRow = Schema.Struct({ id: Schema.Int, at: Schema.Int });

const decodeSeen = Schema.decodeUnknownOption(Schema.Struct({ at: PresenceRow.fields.at }));

export class PresenceStore extends Context.Service<
  PresenceStore,
  {
    readonly seen: (at: number | undefined) => Effect.Effect<void>;
    readonly last: Effect.Effect<number>;
  }
>()("ky/dreaming/Presence") {
  static readonly layer = Layer.effect(
    PresenceStore,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));

      yield* exec(`CREATE TABLE IF NOT EXISTS ky_presence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        at INTEGER NOT NULL)`);

      return PresenceStore.of({
        seen: Effect.fn("Presence.seen")(function* (at) {
          yield* exec("INSERT OR REPLACE INTO ky_presence (id, at) VALUES (1, ?)", at ?? (yield* Clock.currentTimeMillis));
        }),
        last: Effect.map(exec("SELECT at FROM ky_presence WHERE id = 1"), ([row]) =>
          Option.getOrElse(
            Option.map(decodeSeen(row), ({ at }) => at),
            () => 0
          )
        )
      });
    })
  );
}

export class Presence {
  readonly #edge: Edge<PresenceStore>;

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(PresenceStore.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  seen(at?: number): void {
    this.#edge.run(PresenceStore.use((store) => store.seen(at)));
  }

  last(): number {
    return this.#edge.run(PresenceStore.use((store) => store.last));
  }
}
