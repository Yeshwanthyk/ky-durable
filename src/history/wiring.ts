import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Edge, makeEdge } from "../core/edge";
import { Sql } from "../core/sql";
import type { Said, SaidMark, SearchOptions } from "./contract";
import { Index } from "./history";

export { ownMessages, placedBy, runInputs, runOpener, startedByUser, wroteSince } from "./history";

export class History {
  readonly #edge: Edge<Index>;

  constructor(storage: DurableObjectStorage, isChat: (session: string) => boolean, name: (session: string) => string) {
    this.#edge = makeEdge(Index.layer({ isChat, name }).pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  search(query: string, options: SearchOptions = {}): string {
    return this.#edge.run(Index.use((index) => index.search(query, options)));
  }

  since(from: SaidMark, chars: number, now?: number): Said {
    return this.#edge.run(Index.use((index) => index.since(from, chars, now)));
  }

  latest(session: string): string | null {
    return this.#edge.run(Index.use((index) => index.latest(session)));
  }

  rebuild(): void {
    this.#edge.run(Index.use((index) => index.rebuild));
  }
}
