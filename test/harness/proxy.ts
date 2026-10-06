import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket as Socket, WebSocketServer } from "ws";
import { decodeReport, type RunnerReport } from "../../src/runner-protocol.ts";
import { freePort } from "./stack.ts";

/**
 * The network between a runner and the stack, which the harness can break
 * on purpose: hold the runner's reports, drop some, cut the connection, or
 * refuse new ones. Everything else passes through untouched, HTTP included
 * (ky-attach uploads through it), so reconnects are tested without touching
 * the runner.
 */

export type Gate = "accept" | "stall" | "refuse";

export type Proxy = {
  url: string;
  /** Runner connections accepted so far. */
  connections: () => number;
  /** Reports from the runner seen so far, held or dropped ones included. */
  reports: RunnerReport[];
  /** Hold the runner's frames until `release`. */
  hold: () => void;
  release: () => void;
  /** Drop the runner's frames for which `drop` is true. */
  dropWhen: (drop: (report: RunnerReport) => boolean) => void;
  /**
   * Close the runner's connection. Then new ones are accepted, stalled
   * (their handshake waits for `open`) or refused with a 503, as during a
   * deploy, until `open`.
   */
  cut: (then?: Gate) => void;
  /** Accept connections again, stalled ones first. */
  open: () => void;
  close: () => Promise<void>;
};

export async function startProxy(target: string): Promise<Proxy> {
  const port = await freePort();
  const reports: RunnerReport[] = [];
  const live = new Set<{ runner: Socket; upstream: Socket }>();
  let held: Array<() => void> | undefined;
  let drop: (report: RunnerReport) => boolean = () => false;
  let gate: Gate = "accept";
  const stalled: Array<() => void> = [];
  let connections = 0;

  const server: Server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];

    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const headers = new Headers();

    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined && key !== "host") headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }

    const body = chunks.length === 0 ? undefined : new Uint8Array(Buffer.concat(chunks));
    const response = await fetch(`${target}${incoming.url ?? "/"}`, { method: incoming.method, headers, body, redirect: "manual" });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });

  const sockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (gate === "refuse") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");

      return;
    }

    if (gate === "stall") {
      stalled.push(() => accept(request, socket, head));

      return;
    }

    accept(request, socket, head);
  });

  const accept = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    sockets.handleUpgrade(request, socket, head, (runner) => {
      connections++;

      const upstream = new Socket(`${target.replace(/^http/, "ws")}${request.url ?? "/"}`, {
        headers: { Authorization: request.headers.authorization ?? "" }
      });

      const pair = { runner, upstream };
      live.add(pair);
      const early: string[] = [];

      upstream.on("open", () => {
        for (const frame of early.splice(0)) upstream.send(frame);
      });
      upstream.on("message", (data) => {
        if (runner.readyState === Socket.OPEN) runner.send(String(data));
      });

      runner.on("message", (data) => {
        const frame = String(data);
        const report = decodeReport(frame);

        if (report) reports.push(report);

        if (report && drop(report)) return;

        const forward = () => {
          if (upstream.readyState === Socket.OPEN) upstream.send(frame);
          else if (upstream.readyState === Socket.CONNECTING) early.push(frame);
        };

        if (held) held.push(forward);
        else forward();
      });

      const end = () => {
        live.delete(pair);
        runner.close();
        upstream.close();
      };

      runner.on("close", end);
      upstream.on("close", end);
      upstream.on("error", end);
    });
  };

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    reports,
    hold: () => {
      held ??= [];
    },
    release: () => {
      const queued = held ?? [];
      held = undefined;

      for (const forward of queued) forward();
    },
    dropWhen: (predicate) => {
      drop = predicate;
    },
    cut: (then = "accept") => {
      gate = then;

      for (const { runner, upstream } of live) {
        runner.terminate();
        upstream.close();
      }
    },
    open: () => {
      gate = "accept";

      for (const accept of stalled.splice(0)) accept();
    },
    close: async () => {
      for (const { runner, upstream } of live) {
        runner.terminate();
        upstream.close();
      }

      sockets.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
