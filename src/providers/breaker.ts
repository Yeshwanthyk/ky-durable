import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * A provider's circuit breaker. It watches every response the provider's
 * transport gets, and opens on one that says the provider can't take
 * requests now: its key is refused (401), it is out of credit (402), it is
 * rate-limited (429), or it is failing (5xx); or that the transport itself
 * failed, as a dropped tunnel does. While open, models.ts runs the provider's
 * calls on a stand-in. It closes after a cooldown, or at
 * once on a response that succeeds.
 */

const COOLDOWN_MS = 60_000;

/** Whether a response's status opens the breaker. */
function trips(status: number): boolean {
  return status === 401 || status === 402 || status === 429 || status >= 500;
}

export class Breaker {
  readonly #name: string;
  readonly #cooldownMs: number;
  #openUntil = 0;

  constructor(name: string, cooldownMs = COOLDOWN_MS) {
    this.#name = name;
    this.#cooldownMs = cooldownMs;
  }

  /** The provider may take requests: no response has opened the breaker within the cooldown. */
  closed(): boolean {
    return Date.now() >= this.#openUntil;
  }

  /** `fetch`, with each response's status recorded; a request that fails to send opens the breaker too. */
  watch(fetch: FetchFunction): FetchFunction {
    return async (input, init) => {
      let response: Response;

      try {
        response = await fetch(input, init);
      } catch (error) {
        // A call aborted by its caller says nothing about the provider.
        if (!init?.signal?.aborted) this.#open(error instanceof Error ? error.message : String(error));
        throw error;
      }

      if (trips(response.status)) this.#open(`answered ${response.status}`);
      else if (response.ok) this.#openUntil = 0;

      return response;
    };
  }

  #open(why: string): void {
    if (this.closed()) console.warn(`${this.#name} ${why}; its calls run on a stand-in for a while.`);
    this.#openUntil = Date.now() + this.#cooldownMs;
  }
}
