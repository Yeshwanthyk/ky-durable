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
 * KY_RUNNER_PROBE_MS  how long it waits to try again while ky turns it away (default: 10 minutes)
 *
 * Each task finds `ky` on its PATH: `ky attach` shares an image or video, and `ky diff` a
 * repository's changes as a reviewable diff. Both send the task's own token, KY_TASK_TOKEN; a task
 * never gets the machine token.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Type, { type Static } from "typebox";
import { OUTDATED, REPLACED, REVOKED, RUNNER_PATH, type Agent, type MachineFacts } from "../../src/machines/contract.ts";
import { ASK, FACTS_EVERY_MS, lastKnown, scanRepos } from "./facts.ts";
import { HandledSeqs } from "./handled.ts";
import { Runner, type Link } from "./runner.ts";
import type { Settings } from "./settings.ts";
import { tasks } from "./tasks.ts";

/** What `ky runner status` and `ky runner add` read of the running runner. */
export const StatusSchema = Type.Object({
  state: Type.Union([Type.Literal("online"), Type.Literal("offline"), Type.Literal("outdated"), Type.Literal("refused"), Type.Literal("stopped")]),
  machine: Type.String(),
  url: Type.String(),
  version: Type.String(),
  pid: Type.Number(),
  at: Type.Number(),
  reason: Type.Optional(Type.String())
});

export type Status = Static<typeof StatusSchema>;

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
  /** Run by launchd or systemd: a fatal close (REPLACED, REVOKED) exits 0, so the service is not started again only to be refused. */
  service: boolean;
  /** How long to wait before trying again while ky turns the runner away, outdated or its token refused (default: PROBE_MS). */
  probe?: number;
  /** What the runner says it is: one of the user's computers, or ky's cloud machine (`ky runner cloud`). */
  kind?: MachineFacts["kind"];
  /** Stops the runner: its tasks are interrupted, its socket closes and it doesn't reconnect; runRunner then returns. */
  stop?: AbortSignal;
};

/** Ten minutes: a runner ky turns away stays up and tries again this often, so a deploy or an upgrade brings it back. */
const PROBE_MS = 10 * 60_000;

function log(...parts: unknown[]) {
  // The full date and time, in UTC: a log read days later, or beside launchd's, says when.
  console.log(new Date().toISOString(), ...parts);
}

/** This checkout's commit, the runner's version when `ky` runs from one. */
export function checkoutVersion(): string {
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" });

  return head.status === 0 ? head.stdout.trim() : "unknown";
}

/** How long a stopping runner waits for its agents to exit after interrupting them, before it kills them. */
const SHUTDOWN_MS = 6_000;

/** How a lost socket is logged: the reason tells a malformed report (1008) apart from a flaky network. */
const disconnected = (code: number | undefined, reason: string) => `disconnected (${code ?? "error"}${reason ? `: ${reason}` : ""})`;

/** Runs the runner until ky turns it away, or a signal ends it. */
export async function runRunner({ settings, token, state, version, ky, service, kind = "computer", stop, probe = PROBE_MS }: RunOptions): Promise<void> {
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

  /**
   * End every task's agent before the runner goes: each is interrupted, and its process group
   * SIGKILLed if it hasn't exited within SHUTDOWN_MS, so none outlives the runner as an orphan.
   */
  const shutdown = async () => {
    runner.shutdown();
    await work.settle(SHUTDOWN_MS);
  };

  /** Close codes after which retrying cannot help, and what to log before exiting. */
  const FATAL = new Map<number, string>([
    [REPLACED, `another runner connected as ${machine}; exiting. Give each machine its own name.`],
    [REVOKED, `${machine} was removed from ky, or its token is not ky's; exiting. Pair again: in ky, Settings, Machines, Add a machine.`]
  ]);

  const later = `trying again in ${probe >= 60_000 ? `${Math.round(probe / 60_000)} min` : `${probe / 1000}s`}`;

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

  /**
   * Why ky turns this runner away for now, or undefined to retry at once. A deploy of ky or an
   * upgrade on this machine can end either, so the runner waits and tries again rather than exit:
   * a runner ahead of ky, or behind it, is not one to stop for good.
   */
  const turnedAway = async (code: number | undefined): Promise<{ state: "outdated" | "refused"; why: string } | undefined> => {
    // Its goodbye, logged as it came, said which protocol ky speaks.
    if (code === OUTDATED) return { state: "outdated", why: "this ky speaks another runner protocol than ky's Worker. Get the newer ky, then run ky upgrade, or deploy ky" };

    // A failed connect (no code) asks whether ky refused the token; a 4401 close is REVOKED, which is fatal.
    if (code === undefined && (await refused())) return { state: "refused", why: `ky refused ${machine}'s token. Pair again if it was removed: in ky, Settings, Machines, Add a machine` };

    return undefined;
  };

  let socket: WebSocket | undefined;
  let backoff = 1_000;

  const connect = () => {
    // A retry timed before the runner was stopped.
    if (stop?.aborted) return;
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

      const exit = code === undefined ? undefined : FATAL.get(code);

      if (exit) {
        log(exit);
        say("stopped", exit);
        await shutdown();
        process.exit(service ? 0 : 1);
      }

      const away = await turnedAway(code);

      if (away) {
        log(`${away.why}; ${later}`);
        say(away.state, away.why);
        setTimeout(connect, probe);

        return;
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

  let stopping = false;

  /** Until the socket has sent what it buffered, as the stopping report, for a second at most. */
  const sent = async () => {
    for (const until = Date.now() + 1_000; (socket?.bufferedAmount ?? 0) > 0 && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // A second signal while the agents settle changes nothing: the wait is bounded.
      if (stopping) return;
      stopping = true;
      log(`${signal}: stopping, ending each task's agent`);
      say("stopped", signal);
      const told = runner.stopping(`Interrupted: ${kind === "cloud" ? "the container" : "the runner"} was stopped. Send it a message to resume.`);

      void shutdown()
        .then(() => (told ? sent() : undefined))
        .then(() => {
          log("stopped");
          process.exit(0);
        });
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
      socket?.close();
      log("asked to stop: ending each task's agent");
      say("stopped", "asked to stop");
      void shutdown().then(() => {
        log("stopped");
        resolve();
      });
    });
  });
}
