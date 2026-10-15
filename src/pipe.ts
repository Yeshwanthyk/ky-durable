import type { FetchFunction } from "@earendil-works/pi-ai";
import { fromBase64, type HttpRequest, type ObjectFrame, type PipeReport, runnerTag, toBase64 } from "./machines/contract";

/**
 * The object's end of the pipe (C1): a fetch to a port on a paired machine,
 * sent over its runner's socket as an `http_request` and answered by the
 * runner's `http_*` reports. The machine must be online when the request
 * starts; its socket closing fails every request still open on it at once.
 *
 * Each request fails when nothing arrives for `timeoutMs`, waiting for
 * the head or between chunks. C1 has no flow control toward the runner, so a
 * reader that falls `MAX_UNREAD_BYTES` behind ends its request instead of
 * letting the body fill memory; the runner's own backpressure keeps the
 * socket from outrunning the network.
 */

/** How long a request waits for its head, or for the next chunk, before it fails. */
const TIMEOUT_MS = 120_000;

/** How far the reader of a response may fall behind the runner before the request is cancelled. */
const MAX_UNREAD_BYTES = 8 * 1024 * 1024;

const OPEN = 1;

/** Statuses whose response has no body. */
const NO_BODY = new Set([101, 204, 205, 304]);

type Open = {
  readonly machine: string;
  readonly socket: WebSocket;
  /** Settles the fetch: on the head, or on a failure before it. */
  readonly head: { resolve(response: Response): void; reject(error: Error): void };
  /** The body's once the head came; null for a status that has none. */
  body: ReadableStreamDefaultController<Uint8Array> | null | undefined;
  timer: ReturnType<typeof setTimeout>;
  readonly unlisten: () => void;
};

export class RunnerPipe {
  readonly #sockets: (tag: string) => WebSocket[];
  readonly #open = new Map<string, Open>();
  /** How long a request waits for its head, or for the next chunk; tests shorten it. */
  timeoutMs = TIMEOUT_MS;

  constructor(sockets: (tag: string) => WebSocket[]) {
    this.#sockets = sockets;
  }

  /** A fetch to `port` on `machine`, over its runner's socket. The URL's origin is ignored: only its path goes. */
  fetcher(machine: string, port: number): FetchFunction {
    return async (input, init) => {
      const request = new Request(input, init);
      const socket = this.#sockets(runnerTag(machine)).find((each) => each.readyState === OPEN);

      if (!socket) throw new Error(`${machine} is offline.`);
      request.signal.throwIfAborted();

      const url = new URL(request.url);
      const body = request.body ? toBase64(new Uint8Array(await request.arrayBuffer())) : undefined;
      const id = crypto.randomUUID();
      const frame: HttpRequest = { type: "http_request", id, port, method: request.method, path: url.pathname + url.search, headers: Object.fromEntries(request.headers), ...(body !== undefined && { body }) };

      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          this.#send(socket, { type: "http_cancel", id });
          this.#fail(id, request.signal.reason instanceof Error ? request.signal.reason : new Error("Aborted."));
        };

        request.signal.addEventListener("abort", onAbort);

        this.#open.set(id, {
          machine,
          socket,
          head: { resolve, reject },
          body: undefined,
          timer: this.#timer(id),
          unlisten: () => request.signal.removeEventListener("abort", onAbort)
        });

        if (!this.#send(socket, frame)) this.#fail(id, new Error(`${machine} went offline.`));
      });
    };
  }

  /** A runner's answer to a request; one for a request no longer open (cancelled, timed out) is dropped. */
  onReport(report: PipeReport): void {
    const open = this.#open.get(report.id);

    if (!open) return;
    clearTimeout(open.timer);
    open.timer = this.#timer(report.id);

    switch (report.type) {
      case "http_head":
        this.#head(report.id, open, report.status, report.headers);

        return;
      case "http_chunk":
        this.#chunk(report.id, open, report.data);

        return;
      case "http_end":
        open.body?.close();
        this.#close(report.id);

        return;
      case "http_error":
        this.#fail(report.id, new Error(report.message));
    }
  }

  /** The head settles the fetch, with a body that the chunks fill. */
  #head(id: string, open: Open, status: number, headers: Record<string, string>): void {
    if (open.body !== undefined) return;
    open.body = null;

    // Counted in bytes, so desiredSize says how far the reader is behind.
    const body = NO_BODY.has(status)
      ? null
      : new ReadableStream<Uint8Array>(
          {
            start: (controller) => {
              open.body = controller;
            },
            cancel: () => {
              this.#send(open.socket, { type: "http_cancel", id });
              this.#close(id);
            }
          },
          { highWaterMark: 0, size: (chunk) => chunk.byteLength }
        );

    open.head.resolve(new Response(body, { status, headers }));
  }

  #chunk(id: string, open: Open, data: string): void {
    if (!open.body) return;
    open.body.enqueue(fromBase64(data));

    if ((open.body.desiredSize ?? 0) < -MAX_UNREAD_BYTES) {
      this.#send(open.socket, { type: "http_cancel", id });
      this.#fail(id, new Error("The response was read too slowly."));
    }
  }

  /** A runner's socket closed: fail at once every request of `machine` that has no open socket under it now. */
  dropped(machine: string): void {
    for (const [id, open] of this.#open) {
      if (open.machine === machine && open.socket.readyState !== OPEN) this.#fail(id, new Error(`${machine} went offline.`));
    }
  }

  #timer(id: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const open = this.#open.get(id);

      if (open) this.#send(open.socket, { type: "http_cancel", id });
      this.#fail(id, new Error(`No answer for ${this.timeoutMs / 1000}s.`));
    }, this.timeoutMs);
  }

  /** The request is over: before its head the fetch rejects, after it the body errors. */
  #fail(id: string, error: Error): void {
    const open = this.#open.get(id);

    if (!open) return;

    if (open.body === undefined) open.head.reject(error);
    else open.body?.error(error);
    this.#close(id);
  }

  #close(id: string): void {
    const open = this.#open.get(id);

    if (!open) return;
    clearTimeout(open.timer);
    open.unlisten();
    this.#open.delete(id);
  }

  #send(socket: WebSocket, frame: ObjectFrame): boolean {
    if (socket.readyState !== OPEN) return false;

    try {
      socket.send(JSON.stringify(frame));

      return true;
    } catch {
      return false;
    }
  }
}
