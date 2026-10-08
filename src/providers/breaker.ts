import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * A provider's circuit breaker. It watches every response the provider's
 * transport gets, and opens on one that says the provider can't take
 * requests now: its key is refused (401), it is out of credit (402), it is
 * rate-limited (429), or it is failing (5xx). While open, models.ts runs the
 * provider's calls on the fallback model. It closes after a cooldown, or at
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

  /** `fetch`, with each response's status recorded. */
  watch(fetch: FetchFunction): FetchFunction {
    return async (input, init) => {
      const response = await fetch(input, init);

      if (trips(response.status)) {
        if (this.closed()) console.warn(`${this.#name} answered ${response.status}; its calls run on the fallback model for a while.`);
        this.#openUntil = Date.now() + this.#cooldownMs;
      } else if (response.ok) {
        this.#openUntil = 0;
      }

      return response;
    };
  }
}
