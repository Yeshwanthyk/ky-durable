import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Fetch } from "../chatgpt";
import { type Edge, makeEdge } from "../core/edge";
import { isRefusal } from "../core/refusal";
import { Sql } from "../core/sql";
import type { PushDevice } from "./contract";
import { Push, type PushParts } from "./push";

export class Pushes {
  readonly #edge: Edge<Push>;
  readonly #parts: PushParts;
  fetch: Fetch = (input, init) => fetch(input, init);

  constructor(storage: DurableObjectStorage, parts: PushParts) {
    this.#parts = parts;
    this.#edge = makeEdge(Push.layer(parts, (input, init) => this.fetch(input, init)).pipe(Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  key(): Promise<string> {
    return this.#parts.vault().vapidKey();
  }

  subscribe(device: PushDevice): void {
    const result = this.#edge.run(Effect.as(Push.use((push) => push.subscribe(device)), {}));

    if (isRefusal(result)) throw new Error(result.refused);
  }

  unsubscribe(endpoint: string): void {
    this.#edge.run(Push.use((push) => push.unsubscribe(endpoint)));
  }

  async notify(session: string, text: string): Promise<void> {
    try {
      await this.#edge.runPromise(Push.use((push) => push.notify(session, text)));
    } catch (error) {
      console.warn("push", error);
    }
  }
}
