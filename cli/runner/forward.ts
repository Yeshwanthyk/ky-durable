/**
 * The runner's end of the pipe (C1). Each `http_request` for a port this
 * machine shares goes to that port here, and its answer streams back as an
 * `http_head`, `http_chunk`s and an `http_end`, or an `http_error`. Nothing
 * is kept for a reconnect: a request dies with the socket it came on, and
 * the object fails it there too.
 *
 * Each request that fails, or that the local server answers with an error
 * status, is logged on one line: method, port, path without its query, and
 * why. No headers or bodies, which may hold keys.
 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import { fromBase64, type HttpRequest, type RunnerReport, toBase64 } from "../../src/runner-protocol.ts";
import type { Link } from "./runner.ts";

/** Send a request to a port on this machine: ky-runner's goes to 127.0.0.1; the tests' to a fake server. */
export type LocalFetch = (port: number, path: string, init: RequestInit) => Promise<Response>;

/** The most body bytes in one `http_chunk`: 48 KiB, 64 KiB as base64. */
const CHUNK_BYTES = 48 * 1024;

/** While this much is waiting to go out on the socket, the local answer is not read further. */
const HIGH_WATER_BYTES = 1024 * 1024;

/** How often a paused answer looks at the socket again; Node's WebSocket has no drain event. */
const DRAIN_POLL_MS = 20;

/** Request headers fetch sets itself, or refuses. */
const REQUEST_HOP = new Set(["connection", "content-length", "host", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/** Response headers that describe the body as it came, not as it is sent on: fetch has already decoded it. */
const RESPONSE_HOP = new Set([...REQUEST_HOP, "content-encoding"]);

export class Forwarder {
  readonly #fetch: LocalFetch;
  readonly #ports: () => readonly number[];
  readonly #log: (line: string) => void;
  readonly #open = new Map<string, AbortController>();

  constructor(fetch: LocalFetch, ports: () => readonly number[], log: (line: string) => void) {
    this.#fetch = fetch;
    this.#ports = ports;
    this.#log = log;
  }

  /** Forward `request` and answer it on `link`, the socket it came on; a port this machine doesn't share is refused. */
  request(link: Link, request: HttpRequest): void {
    if (!this.#ports().includes(request.port)) {
      this.#log(`${described(request)}: refused, this machine doesn't share port ${request.port}`);
      link.send(JSON.stringify({ type: "http_error", id: request.id, message: `This machine doesn't share port ${request.port}.` } satisfies RunnerReport));

      return;
    }

    if (this.#open.has(request.id)) return;
    const abort = new AbortController();
    this.#open.set(request.id, abort);
    void this.#serve(link, request, abort);
  }

  /** Forward the request; a failure that is not its cancel is answered with an `http_error`. */
  async #serve(link: Link, request: HttpRequest, abort: AbortController): Promise<void> {
    try {
      await this.#forward(link, request, abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        const cause = error instanceof Error ? causeOf(error.cause) : undefined;

        this.#log(`${described(request)}: failed, ${cause ? `${message} (${cause})` : message}`);
        link.send(JSON.stringify({ type: "http_error", id: request.id, message } satisfies RunnerReport));
      }

      abort.abort();
    } finally {
      if (this.#open.get(request.id) === abort) this.#open.delete(request.id);
    }
  }

  /** The object no longer wants the answer. */
  cancel(id: string): void {
    this.#open.get(id)?.abort();
    this.#open.delete(id);
  }

  /** The socket closed: every request on it is over. */
  closed(): void {
    for (const abort of this.#open.values()) abort.abort();
    this.#open.clear();
  }

  async #forward(link: Link, request: HttpRequest, signal: AbortSignal): Promise<void> {
    const { id, port, method, path, headers, body } = request;

    const report = (message: RunnerReport) => {
      if (!link.send(JSON.stringify(message))) throw new Error("The socket to ky closed.");
    };

    const response = await this.#fetch(port, path, {
      method,
      headers: without(Object.entries(headers), REQUEST_HOP),
      body: body === undefined ? undefined : fromBase64(body),
      signal
    });

    if (response.status >= 400) this.#log(`${described(request)}: answered ${response.status}`);
    report({ type: "http_head", id, status: response.status, headers: without(response.headers.entries(), RESPONSE_HOP) });

    const reader = response.body?.getReader();

    for (let read = await reader?.read(); read && !read.done; read = await reader!.read()) {
      for (let at = 0; at < read.value.length; at += CHUNK_BYTES) {
        // Backpressure: a slow socket stops the read, and so the local server, rather than filling memory.
        while (link.buffered() > HIGH_WATER_BYTES) {
          await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
          signal.throwIfAborted();
        }

        report({ type: "http_chunk", id, data: toBase64(read.value.subarray(at, at + CHUNK_BYTES)) });
      }
    }

    report({ type: "http_end", id });
  }
}

/** A request as its log line names it: `GET :8317/v1/models`, without the query, which may hold a key. */
function described({ method, port, path }: HttpRequest): string {
  return `${method} :${port}${path.split("?")[0]}`;
}

/** A system error's code, as Node's errors carry it. */
const Coded = Type.Object({ code: Type.String() });

/** What fetch hides under "fetch failed": the cause's code, such as ECONNREFUSED, else its message. */
function causeOf(cause: Error["cause"]): string | undefined {
  if (Value.Check(Coded, cause)) return cause.code;

  return cause instanceof Error ? cause.message : undefined;
}

function without(headers: Iterable<[string, string]>, dropped: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries([...headers].filter(([name]) => !dropped.has(name.toLowerCase())));
}
