/**
 * `ky runner run`: ky's machine runner. It dials into the user's ky over a WebSocket, as the
 * machine `ky runner add` paired, and runs each task as a Claude Code or Codex session on this
 * machine, with its own `claude` or `codex` login, shell, files and browser. Nothing listens on a
 * port. launchd or systemd runs it (cli/runner/service.ts); run in a terminal, it logs there.
 *
 * Its settings are runner.json's, each overridable by a KY_ variable (cli/runner/settings.ts),
 * and:
 *
 * KY_CLAUDE       the claude executable (default: claude)
 * KY_CODEX        the codex executable (default: codex)
 * KY_STATE_DIR    what must outlive the runner: handled seqs, each Codex task's home, its status (default: ~/.ky)
 *
 * Each task finds `ky` on its PATH: `ky attach` shares an image or video, and `ky diff` a
 * repository's changes as a reviewable diff. Both send the task's own token, KY_TASK_TOKEN; a task
 * never gets the machine token.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OUTDATED, REPLACED, REVOKED, RUNNER_PATH, type Agent, type MachineFacts } from "../../src/runner-protocol.ts";
import { ASK, FACTS_EVERY_MS, lastKnown, scanRepos } from "./facts.ts";
import { HandledSeqs } from "./handled.ts";
import { Runner, type Link } from "./runner.ts";
import type { Settings } from "./settings.ts";
import { tasks } from "./tasks.ts";

/** What `ky runner status` and `ky runner add` read of the running runner. */
export type Status = { state: "online" | "offline" | "stopped"; machine: string; url: string; version: string; pid: number; at: number; reason?: string };

export function statusFile(state: string): string {
  return join(state, "runner-status.json");
}

export type RunOptions = {
  settings: Settings;
  token: string;
  /** Where the runner keeps its state (KY_STATE_DIR). */
  state: string;
  version: string;
  /** The command line that runs this `ky`, for each task's `ky`. */
  ky: string[];
  /** Run by launchd or systemd: a refusal exits 0, so the service is not started again only to be refused. */
  service: boolean;
  /** What the runner says it is: one of the user's computers, or ky's cloud machine (`ky runner cloud`). */
  kind?: MachineFacts["kind"];
  /** Stops the runner: its tasks are interrupted, its socket closes and it doesn't reconnect; runRunner then returns. */
  stop?: AbortSignal;
};

function log(...parts: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

/** This checkout's commit, the runner's version when `ky` runs from one. */
export function checkoutVersion(): string {
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" });

  return head.status === 0 ? head.stdout.trim() : "unknown";
}

/** How a lost socket is logged: the reason tells a malformed report (1008) apart from a flaky network. */
const disconnected = (code: number | undefined, reason: string) => `disconnected (${code ?? "error"}${reason ? `: ${reason}` : ""})`;

/** Runs the runner until ky turns it away, or a signal ends it. */
export async function runRunner({ settings, token, state, version, ky, service, kind = "computer", stop }: RunOptions): Promise<void> {
  const { url, name: machine, workdir } = settings;
  const claude = process.env.KY_CLAUDE ?? "claude";
  const codex = process.env.KY_CODEX ?? "codex";

  const work = tasks({
    url,
    workdir,
    permissionMode: settings.permissionMode,
    chrome: settings.chrome,
    claude,
    codex,
    machineCodexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    state,
    ky,
    log
  });

  const agents = { claude: lastKnown(claude, () => ASK.claude(claude)), codex: lastKnown(codex, () => ASK.codex(codex)) } satisfies Record<Agent, ReturnType<typeof lastKnown>>;
  /** An agent the user didn't share is, to ky, not here. */
  const shared = (agent: Agent) => (settings.agents[agent] ? agents[agent].facts() : { installed: false, signedIn: false });
  let repos: { at: number; value: MachineFacts["repos"] } | undefined;

  /** What this machine is, for ky to choose where work goes; checked at most every few minutes. */
  const machineFacts = (): MachineFacts => {
    for (const agent of Object.values(agents)) void agent.refresh();

    if (!repos || Date.now() - repos.at > FACTS_EVERY_MS) {
      repos = { at: Date.now(), value: scanRepos(settings.repos) };
      work.sweepCodexHomes();
    }

    return { os: process.platform, chrome: settings.chrome, repos: repos.value, agents: { claude: shared("claude"), codex: shared("codex") }, ports: settings.ports, kind };
  };

  const runner = new Runner(
    work.spawnAgent,
    (line) => log(line),
    new HandledSeqs(join(state, `handled-${machine}.json`), `${url} ${machine}`),
    version,
    machineFacts,
    (port, path, init) => fetch(`http://127.0.0.1:${port}${path}`, init)
  );

  /** Says how the runner is, for `ky runner status`; a write that fails is only logged. */
  const say = (now: Status["state"], reason?: string) => {
    const status: Status = { state: now, machine, url, version, pid: process.pid, at: Date.now(), ...(reason && { reason }) };

    try {
      mkdirSync(state, { recursive: true });
      const next = `${statusFile(state)}.${process.pid}`;
      writeFileSync(next, JSON.stringify(status));
      renameSync(next, statusFile(state));
    } catch (error) {
      log(`could not write the status: ${String(error)}`);
    }
  };

  /** Close codes after which retrying cannot help, and what to log before exiting. */
  const FATAL = new Map<number | undefined, string>([
    [REPLACED, `another runner connected as ${machine}; exiting. Give each machine its own name.`],
    // Its goodbye, logged as it came, said which protocol ky speaks.
    [OUTDATED, "this ky speaks another runner protocol than ky's Worker; exiting. Update it. Get the newer ky, then run ky upgrade, which restarts this runner."],
    [REVOKED, `${machine} was removed from ky, or its token is not ky's; exiting. Pair again: in ky, Settings, Machines, Add a machine.`]
  ]);

  /**
   * Whether ky turns this runner's token away. A WebSocket says nothing about a refused upgrade,
   * so a failed connect asks once over plain HTTP, where the route answers 401 for a bad token
   * before 426 for no upgrade.
   */
  const refused = async (): Promise<boolean> => {
    try {
      const response = await fetch(`${url}${RUNNER_PATH}${machine}`, { headers: { Authorization: `Bearer ${token}` } });

      return response.status === 401;
    } catch {
      return false;
    }
  };

  /** What to log before exiting after a close with `code`, or undefined to retry; a failed connect (no code) asks whether ky refused the token. */
  const fatal = async (code: number | undefined) => FATAL.get(code === undefined && (await refused()) ? REVOKED : code);

  let socket: WebSocket | undefined;
  let backoff = 1_000;

  const connect = () => {
    // SAFETY: Node's WebSocket (undici) and Bun's take headers as a non-standard option the types leave out.
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}${RUNNER_PATH}${machine}`, { headers: { Authorization: `Bearer ${token}` } } as any);

    const link: Link = {
      send: (text) => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(text);

        return true;
      },
      buffered: () => ws.bufferedAmount
    };

    socket = ws;
    ws.addEventListener("open", () => {
      backoff = 1_000;
      log(`connected to ${url} as ${machine}, working in ${workdir}`);
      say("online");
      runner.open(link);
    });
    ws.addEventListener("message", (event) => runner.message(String(event.data)));

    // Once per socket: Node fires only `error`, never `close`, when a connect fails.
    const lost = async (code: number | undefined, reason = "") => {
      if (socket !== ws || stop?.aborted) return;
      socket = undefined;
      runner.closed(link);

      const exit = await fatal(code);

      if (exit) {
        log(exit);
        say("stopped", exit);
        runner.shutdown();
        process.exit(service ? 0 : 1);
      }

      log(`${disconnected(code, reason)}, retrying in ${backoff / 1000}s`);
      say("offline", disconnected(code, reason));
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    };

    ws.addEventListener("close", (event) => void lost(event.code, event.reason));
    ws.addEventListener("error", () => {
      void lost(undefined);

      try {
        ws.close();
      } catch {
        // Never opened.
      }
    });
  };

  // Keep the socket alive through idle proxies.
  const keepalive = setInterval(() => runner.keepalive(), 30_000);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      runner.shutdown();
      say("stopped", signal);
      process.exit(0);
    });
  }

  work.installKy();
  say("offline", "starting");

  // The first hello waits for the first answers, so it does not say signed out of a machine that is not.
  await Promise.all(Object.values(agents).map((agent) => agent.refresh()));

  if (stop?.aborted) {
    clearInterval(keepalive);

    return;
  }

  connect();
  await new Promise<void>((resolve) => {
    stop?.addEventListener("abort", () => {
      clearInterval(keepalive);
      runner.shutdown();
      socket?.close();
      say("stopped", "asked to stop");
      resolve();
    });
  });
}
