import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Edge, makeEdge } from "../core/edge";
import { isRefusal } from "../core/refusal";
import { Sql } from "../core/sql";
import type { ModelChoice, Purpose } from "./contract";
import { Purposes, type Valid } from "./settings";

export class Settings {
  readonly #edge: Edge<Purposes>;
  readonly #listeners = new Set<(purpose: Purpose, choice: ModelChoice) => void>();

  constructor(storage: DurableObjectStorage, valid: Valid) {
    this.#edge = makeEdge(Purposes.layer(valid).pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  onChange(listener: (purpose: Purpose, choice: ModelChoice) => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  get(purpose: Purpose): ModelChoice | undefined {
    return this.#edge.run(Purposes.use((purposes) => purposes.get(purpose)));
  }

  set(purpose: Purpose, choice: ModelChoice): ModelChoice {
    const kept = this.#edge.run(Purposes.use((purposes) => purposes.set(purpose, choice)));

    if (isRefusal(kept)) throw new Error(kept.refused);

    for (const listener of this.#listeners) listener(purpose, kept);

    return kept;
  }
}
