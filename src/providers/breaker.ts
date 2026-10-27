import type { FetchFunction } from "@earendil-works/pi-ai";

const COOLDOWN_MS = 60_000;

function trips(status: number): boolean {
  return status === 401 || status === 402 || status === 429 || status >= 500;
}

export type Now = () => number;

export class Breaker {
  readonly #name: string;
  readonly #now: Now;
  #openUntil = 0;
  #failure: string | undefined;

  constructor(name: string, now: Now) {
    this.#name = name;
    this.#now = now;
  }

  closed(): boolean {
    return this.#now() >= this.#openUntil;
  }

  failure(): string | undefined {
    return this.#failure;
  }

  watch(fetch: FetchFunction): FetchFunction {
    return async (input, init) => {
      let response: Response;

      try {
        response = await fetch(input, init);
      } catch (error) {
        if (!init?.signal?.aborted) this.#open(error instanceof Error ? error.message : String(error));
        throw error;
      }

      if (trips(response.status)) this.#open(`answered ${response.status}`);
      else if (response.ok) {
        this.#openUntil = 0;
        this.#failure = undefined;
      }

      return response;
    };
  }

  #open(why: string): void {
    if (this.closed()) console.warn(`${this.#name} ${why}; its calls run on a stand-in for a while.`);
    this.#openUntil = this.#now() + COOLDOWN_MS;
    this.#failure = why;
  }
}
