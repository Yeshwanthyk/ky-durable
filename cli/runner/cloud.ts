/**
 * `ky runner cloud`: the cloud machine's runner, the entrypoint of ky's container image. The
 * CloudMachine (src/cloud.ts) starts the container with what it pairs as, and talks to this over
 * HTTP on AGENT_CLOUD_PORT:
 *
 *   GET  /ping     whether it is up: waiting for its files, running, or stopped
 *   PUT  /restore  a tar.gz of what the last sleep saved (or nothing, the first time), unpacked into
 *                  the home; then the runner dials ky, so a resumed session finds its files. A save
 *                  cut off or corrupted on its way is refused (500), the home untouched, still waiting
 *   POST /save     stop the runner (its socket closes, it takes no more runs), then answer with a
 *                  tar.gz of what must outlive the container: Claude Code's sessions, the runner's
 *                  state (each Codex task's home, the handled seqs) and the work trees, streamed as
 *                  tar writes it (chunked, no content-length); a tar that fails breaks the answer off
 *   GET  /snapshot the same tar.gz while the runner keeps running, after a turn ends: the container
 *                  may then die at any time and lose at most the open turn; 409 unless it runs
 *
 * Its settings are the variables `ky runner run` reads with no runner.json (cli/runner/settings.ts),
 * and:
 *
 *   AGENT_RUNNER_TOKEN  the machine token the CloudMachine minted for this start; tasks never see it
 *   AGENT_CLOUD_PORT    where the CloudMachine reaches this (default: 8080)
 *   AGENT_GITHUB_PROXY  where git reaches github.com (default: http://github.internal/api/git/, which
 *                       the CloudMachine routes to the Worker's GitHub proxy, which holds the token)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Context } from "../commands.ts";
import { checkoutVersion, runRunner } from "./run.ts";
import { pack, unpack } from "./save.ts";
import { withEnv } from "./settings.ts";
import { compiled } from "./system.ts";
import { envNames, fromEnv } from "../../src/machines/contract.ts";

/** Where the CloudMachine reaches the runner, unless AGENT_CLOUD_PORT says. */
const CLOUD_PORT = 8080;

const GITHUB_PROXY = "http://github.internal/api/git/";

/** What a save leaves out: what's rebuilt on the next start, and dependencies a task installs again. */
const EXCLUDED = ["node_modules", ".ky/bin", ".ky/runner-status.json"];

type State = "waiting" | "running" | "stopped";

/** Run `command`; it fails unless it exits 0. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`))));
  });
}

/** git fetches and pushes github.com through ky's proxy, which adds the token, and commits as ky. */
async function configureGit(home: string, proxy: string): Promise<void> {
  // The home's own file, which is what --global means in the container, and never a computer's.
  const file = ["config", "--file", path.join(home, ".gitconfig")];

  await run("git", [...file, `url.${proxy}.insteadOf`, "https://github.com/"]);
  await run("git", [...file, "user.name", "ky"]);
  await run("git", [...file, "user.email", "ky@users.noreply.github.com"]);
}

/** The folders a save keeps, relative to the home, of those that are there. */
function kept(home: string, folders: string[]): string[] {
  return folders.flatMap((folder) => {
    const relative = path.relative(home, folder);

    return !relative.startsWith("..") && !path.isAbsolute(relative) && existsSync(folder) ? [relative] : [];
  });
}

const answer = (response: ServerResponse, status: number, body = "") => response.writeHead(status, { "content-type": "text/plain" }).end(body);

export async function cloudCommand(context: Context): Promise<number> {
  const { env, system } = context;
  const token = fromEnv(env, "RUNNER_TOKEN");

  if (!token) throw new Error("ky runner cloud runs in ky's cloud machine, which passes AGENT_RUNNER_TOKEN; on a computer, run ky runner run");

  for (const name of envNames("RUNNER_TOKEN")) delete process.env[name];
  const settings = withEnv(undefined, env, system);
  const version = compiled() ? (await context.release()).version : checkoutVersion();
  const saved = [path.join(system.home, ".claude", "projects"), system.state, settings.workdir];
  // And each Codex task's login, in its home under the state dir: ky sends one with every run.
  const excluded = [...EXCLUDED, path.join(path.relative(system.home, system.state), "codex", "*", "auth.json")];
  const stop = new AbortController();
  let state: State = "waiting";
  let runner: Promise<void> | undefined;

  await configureGit(system.home, fromEnv(env, "GITHUB_PROXY") ?? GITHUB_PROXY);

  const restore = async (request: IncomingMessage, response: ServerResponse) => {
    if (state !== "waiting") return answer(response, 409, `the runner is ${state}`);
    // Throws on a save that isn't whole, which answers 500 and leaves the runner waiting.
    await unpack(request, system.home);
    state = "running";
    runner = runRunner({ settings, token, state: system.state, version, ky: system.ky, service: false, kind: "cloud", stop: stop.signal });
    answer(response, 204);
  };

  /** Answer with a tar.gz of what must outlive the container. */
  const archived = async (response: ServerResponse) => {
    const archive = pack(system.home, kept(system.home, saved), excluded);

    response.writeHead(200, { "content-type": "application/gzip" });
    // A tar that fails rejects this, and the server breaks the answer off: the hub never stores it as whole.
    await pipeline(archive, response);
  };

  const save = async (response: ServerResponse) => {
    if (state === "running") {
      stop.abort();
      await runner;
    }

    state = "stopped";
    await archived(response);
  };

  const snapshot = (response: ServerResponse) => (state === "running" ? archived(response) : Promise.resolve(answer(response, 409, `the runner is ${state}`)));

  const server = createServer((request, response) => {
    const route = `${request.method} ${request.url}`;

    const handled =
      route === "GET /ping"
        ? Promise.resolve(answer(response, 200, state))
        : route === "PUT /restore"
          ? restore(request, response)
          : route === "POST /save"
            ? save(response)
            : route === "GET /snapshot"
              ? snapshot(response)
              : Promise.resolve(answer(response, 404));

    handled.catch((error: Error) => {
      console.error(`${route} failed`, error);

      if (!response.headersSent) answer(response, 500, String(error));
      else response.destroy();
    });
  });

  const port = Number(fromEnv(env, "CLOUD_PORT") ?? CLOUD_PORT);

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`ky runner cloud: waiting on port ${port} for its files`);
  await new Promise(() => {});

  return 0;
}
