/**
 * The runner's end of the pipe (C1). Each `http_request` for a port this
 * machine shares goes to that port here, and its answer streams back as an
 * `http_head`, `http_chunk`s and an `http_end`, or an `http_error`. Nothing
 * is kept for a reconnect: a request dies with the socket it came on, and
 * the object fails it there too.
 */

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
  readonly #open = new Map<string, AbortController>();

  constructor(fetch: LocalFetch, ports: () => readonly number[]) {
    this.#fetch = fetch;
    this.#ports = ports;
  }

  /** Forward `request` and answer it on `link`, the socket it came on; a port this machine doesn't share is refused. */
  request(link: Link, request: HttpRequest): void {
    if (!this.#ports().includes(request.port)) {
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
      if (!abort.signal.aborted) link.send(JSON.stringify({ type: "http_error", id: request.id, message: error instanceof Error ? error.message : String(error) } satisfies RunnerReport));
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

  async #forward(link: Link, { id, port, method, path, headers, body }: HttpRequest, signal: AbortSignal): Promise<void> {
    const report = (message: RunnerReport) => {
      if (!link.send(JSON.stringify(message))) throw new Error("The socket to ky closed.");
    };

    const response = await this.#fetch(port, path, {
      method,
      headers: without(Object.entries(headers), REQUEST_HOP),
      body: body === undefined ? undefined : fromBase64(body),
      signal
    });

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

function without(headers: Iterable<[string, string]>, dropped: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries([...headers].filter(([name]) => !dropped.has(name.toLowerCase())));
}
