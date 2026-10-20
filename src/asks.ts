/**
 * The page's asks: messages whose answer it waits on, by id. Every ask settles, one way: with its answer,
 * checked against what that ask is answered with; or failed, by an error frame for it, the socket closing,
 * an answer that isn't what the ask expects, or a minute without any of those. An ask made while the socket
 * is down is held and sent when it opens, within the same minute.
 */
import type { JsonValue } from "@earendil-works/pi-ai";
import { decode } from "./core/decode";
import { ANSWERS, type Answer, type Ask } from "./server-frames";

/** How long an ask waits for its answer. */
const ASK_TIMEOUT_MS = 60_000;

type Waiting = { answer(result: JsonValue): void; fail(error: Error): void };

export class Asks {
  readonly #waiting = new Map<string, Waiting>();
  /** Asks made while the socket was down, by id: the message to send when it opens. */
  readonly #unsent = new Map<string, string>();
  readonly #timeout: number;

  constructor(timeout = ASK_TIMEOUT_MS) {
    this.#timeout = timeout;
  }

  /** Wait for the answer to ask `id`, a message of `type`. */
  wait<Type extends Ask>(type: Type, id: string): Promise<Answer<Type>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(id, `ky didn't answer within ${this.#timeout / 1000}s.`), this.#timeout);

      const settled = () => {
        clearTimeout(timer);
        this.#waiting.delete(id);
        this.#unsent.delete(id);
      };

      this.#waiting.set(id, {
        answer: (result) => {
          settled();

          try {
            resolve(decode(ANSWERS[type], result, `ky's answer to ${type}`));
          } catch (error) {
            reject(error);
          }
        },
        fail: (error) => {
          settled();
          reject(error);
        }
      });
    });
  }

  /** Settle ask `id` with the server's answer; an id nothing waits on is a fire-and-forget command's. */
  answer(id: string, result: JsonValue): void {
    this.#waiting.get(id)?.answer(result);
  }

  /** Hold ask `id`'s message until the socket opens. */
  hold(id: string, message: string): void {
    if (this.#waiting.has(id)) this.#unsent.set(id, message);
  }

  /** The held messages, to send now the socket is open; they are no longer held. */
  release(): string[] {
    const messages = [...this.#unsent.values()];
    this.#unsent.clear();

    return messages;
  }

  /** Fail ask `id` with why. */
  fail(id: string, message: string): void {
    this.#waiting.get(id)?.fail(new Error(message));
  }

  /** Fail every ask sent and still waiting: the socket closed, and a new one won't answer them. A held one waits on. */
  close(): void {
    // A Map visits each key once even as the loop deletes them.
    for (const id of this.#waiting.keys()) {
      if (!this.#unsent.has(id)) this.fail(id, "The connection to ky closed before it answered.");
    }
  }

  /** How many asks are waiting. */
  get size(): number {
    return this.#waiting.size;
  }
}

