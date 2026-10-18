/**
 * A fake of Cloudflare's container for the cloud machine, in node: the stack's CloudMachine
 * (src/tests/stack.ts) drives it over HTTP as the real one drives `ctx.container`.
 *
 *   GET  /running   "true" while a container runs
 *   POST /start     start one: `ky runner cloud` with the JSON env given, in a fresh, empty HOME,
 *                   as a new container starts from the image with nothing of the last one's
 *   POST /destroy   kill it and throw its HOME away
 *   *    /port/...  a request to the runner's port, as `getTcpPort(8080).fetch` is; after a start
 *                   it refused, a 503 that says so with REFUSED_HEADER, which the stack's box
 *                   throws as Cloudflare's error; a save it was told to cut off (`cutSaves`) reaches
 *                   the runner, which stops, and its answer breaks off after the headers; while
 *                   saves fail (`failSaves`), a save is a 500 that never reaches the runner
 *
 * What it changes from the env it is given: KY_URL is the harness's proxy, so a scenario can break
 * the runner's network; KY_GITHUB_PROXY is the stack's github.internal route, which the real
 * container reaches through `interceptOutboundHttp`; and the fake agent CLIs are the ones run.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, request as forward, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { portOf } from "./port.ts";

/** Marks the fake's answer for a start it refused: Cloudflare's `fetch` throws its error then. */
const REFUSED_HEADER = "x-fake-refused";

/** What Cloudflare says when it has no container to give the Durable Object. */
const NO_INSTANCE = "There is no container instance that can be provided to this Durable Object, try again later";

export type ContainerHost = {
  url: string;
  /** The containers started so far. */
  starts: () => number;
  /** Whether one runs now. */
  running: () => boolean;
  /** Kill the container as a crash does, keeping nothing. */
  crash: () => Promise<void>;
  /** Refuse the next `count` starts, as Cloudflare does while the last container still holds the instance. */
  refuse: (count: number) => void;
  /** The starts refused so far. */
  refused: () => number;
  /** Cut off the next `count` saves on their way back, as a dropped connection does: the runner is left stopped, its files unsaved. */
  cutSaves: (count: number) => void;
  /** The saves cut off so far. */
  cutOff: () => number;
  /** From now on, while `on`, answer every save with a 500 before it reaches the runner, which keeps running. */
  failSaves: (on: boolean) => void;
  /** The saves answered 500 so far. */
  failedSaves: () => number;
  /** Send the runner SIGTERM, as the platform does to stop a container, and wait for it to exit. */
  terminate: () => Promise<void>;
  close: () => Promise<void>;
};

export type HostOptions = {
  /** `ky`, as the image's entrypoint runs it: a command and its first arguments. */
  ky: readonly string[];
  /** Where the runner dials ky, in place of the origin the CloudMachine gives. */
  kyUrl: string;
  /** Where git reaches github.com. */
  github: string;
  /** More of the container's env: the fake CLIs and their logs. */
  env: Record<string, string>;
  /** A directory for each container's log. */
  logs: string;
};

async function freePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server);

  await new Promise((resolve) => server.close(resolve));

  return port;
}

export async function serveContainer(options: HostOptions): Promise<ContainerHost> {
  let box: { child: ChildProcess; home: string; port: number } | undefined;
  let starts = 0;
  let refusing = 0;
  let refused = 0;
  let cutting = 0;
  let cutOff = 0;
  let failing = false;
  let failedSaves = 0;
  /** Whether the last start was refused, so nothing runs and the port says why. */
  let unplaced = false;

  /** Send `child` `signal`, if it still runs, and wait for it to exit. */
  const end = async (child: ChildProcess, signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));

    child.kill(signal);
    await exited;
  };

  const kill = async () => {
    const was = box;

    box = undefined;

    if (!was) return;

    await end(was.child, "SIGKILL");

    rmSync(was.home, { recursive: true, force: true });
  };

  const start = async (env: Record<string, string>) => {
    await kill();
    unplaced = refusing > 0;

    if (unplaced) {
      refusing--;
      refused++;

      return;
    }

    starts++;
    const home = mkdtempSync(path.join(tmpdir(), "ky-cloud-home-"));
    const port = await freePort();
    const [command, ...args] = options.ky;
    const log = createWriteStream(path.join(options.logs, `cloud-${starts}.log`));

    const child = spawn(command!, [...args, "runner", "cloud"], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        ...env,
        ...options.env,
        KY_URL: options.kyUrl,
        KY_GITHUB_PROXY: options.github,
        KY_CLOUD_PORT: String(port),
        KY_RUNNER_PORTS: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    box = { child, home, port };
  };

  /** Whether this request is a save to cut off: it takes one of the cuts asked for. */
  const cutsThis = (request: IncomingMessage) => {
    if (request.method !== "POST" || request.url !== "/port/save" || cutting === 0) return false;
    cutting--;

    return true;
  };

  /** No container runs: after a refused start, a 503 that says so, as Cloudflare's; else nothing answers. */
  const noBox = (response: ServerResponse) => {
    if (unplaced) response.writeHead(503, { [REFUSED_HEADER]: "1" }).end(NO_INSTANCE);
    else response.writeHead(502).end("no container");
  };

  /** Whether this request is a save while saves fail: answered 500 here, it never reaches the runner. */
  const failsSave = (request: IncomingMessage, response: ServerResponse) => {
    if (!failing || request.method !== "POST" || request.url !== "/port/save") return false;
    failedSaves++;
    response.writeHead(500).end("the save failed");

    return true;
  };

  /** Forward the request to the runner on `port`; a cut one's answer breaks off after its headers. */
  const forwardTo = (port: number, request: IncomingMessage, response: ServerResponse, cut: boolean) => {
    const upstream = forward({ host: "127.0.0.1", port, method: request.method, path: request.url?.slice("/port".length), headers: request.headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);

      if (!cut) return void answer.pipe(response);
      cutOff++;
      answer.destroy();
      response.destroy();
    });

    // Nothing listens yet: the container is still starting, as the real one refuses then.
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502).end(String(error));
      else response.destroy();
    });
    request.pipe(upstream);
  };

  /** A request to the runner's port, as `getTcpPort(8080).fetch` is. */
  const toPort = (request: IncomingMessage, response: ServerResponse) => {
    if (!box) return noBox(response);

    if (!failsSave(request, response)) forwardTo(box.port, request, response, cutsThis(request));
  };

  const server: Server = createServer((request, response) => {
    const route = `${request.method} ${request.url}`;

    if (route === "GET /running") {
      response.end(String(box !== undefined && box.child.exitCode === null));

      return;
    }

    if (route === "POST /destroy") {
      void kill().then(() => response.writeHead(204).end());

      return;
    }

    if (route === "POST /start") {
      let body = "";

      request.on("data", (chunk: Buffer) => (body += chunk));
      request.on("end", () => {
        void start(JSON.parse(body)).then(() => response.writeHead(204).end());
      });

      return;
    }

    if (request.url?.startsWith("/port/")) return toPort(request, response);
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = portOf(server);

  return {
    url: `http://127.0.0.1:${port}`,
    starts: () => starts,
    running: () => box !== undefined && box.child.exitCode === null,
    crash: kill,
    refuse: (count) => {
      refusing = count;
    },
    refused: () => refused,
    cutSaves: (count) => {
      cutting = count;
    },
    cutOff: () => cutOff,
    failSaves: (on) => {
      failing = on;
    },
    failedSaves: () => failedSaves,
    terminate: async () => {
      if (box) await end(box.child, "SIGTERM");
    },
    close: async () => {
      await kill();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
