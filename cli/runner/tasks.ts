/**
 * How a runner starts each task's agent: `claude` or `codex` in the workdir, with C1's env and
 * ky's task instructions, and `ky` on its PATH for `ky attach` and `ky diff`.
 *
 * A task's commands see the runner's environment without ky's own KY_ variables, plus C1's
 * (KY_URL, KY_TASK, KY_TASK_TOKEN): the user's own OPENAI_API_KEY and *_SECRET included, under
 * Codex as under Claude Code (Codex would drop them, and KY_TASK_TOKEN with them). An
 * OPENAI_API_KEY here also makes Codex bill that API key rather than sign in with auth.json.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Agent, CodexCreds, RunCreds } from "../../src/machines/contract.ts";
import { claudeArgs } from "./claude.ts";
import { codexArgs } from "./codex.ts";
import type { AgentProcess, Launch, ProcessEvents, SpawnAgent } from "./runner.ts";

export type TaskConfig = {
  url: string;
  workdir: string;
  permissionMode: string;
  chrome: boolean;
  /** The agents' executables. */
  claude: string;
  codex: string;
  /** Where the machine's own Codex keeps its login. */
  machineCodexHome: string;
  /** Where the runner keeps what must outlive it: each Codex task's home, and the `ky` tasks run. */
  state: string;
  /** The command line that runs this `ky`. */
  ky: string[];
  log: (line: string) => void;
};

/** Added to the agent's own instructions in every task: Claude Code's system prompt, Codex's developer instructions. */
function taskPrompt(workdir: string): string {
  const capture = join(workdir, ".capture");

  return `You are running a task for ky, the user's agent; the user reads the result in ky, often on a phone.

To show the user a screenshot, a recording, a sound or a chart, attach it: ky attach <file> [caption] (png, jpeg, webp, gif, webm, mp4, m4a, mp3, ogg, opus or wav, at most 25 MB). It appears on this task and in its report. Attach every image, video or audio file you make for the user, and mention it in your answer.
- For web pages use Playwright. The first time, install it in ${capture}: mkdir -p ${capture} && cd ${capture} && echo '{"private":true}' > package.json && npm install playwright && npx playwright install chromium. Run capture scripts from there.
- Screenshot at a 390x844 viewport unless asked otherwise. Record video with the browser context option recordVideo: { dir, size }; the webm is saved when the context closes.
- Save captures under ${join(workdir, ".captures")}, never inside a repository.

When you change code in a git repository, run ky diff from inside it before you answer, and again after any later change: the user sees the changes on this task and can comment on lines. It shares everything since the branch left the default branch; pass a commit (ky diff <base>) to start elsewhere.`;
}

/** Added for Claude Code with Chrome shared, which gives it the user's Chrome. */
const CHROME_PROMPT = `

For anything that needs the user's logins, use the user's own Chrome through the Claude in Chrome tools; Playwright starts logged out. Never read, copy or report passwords, cookies or tokens.`;

/**
 * How long a Codex task's home is kept after its last turn: two weeks, as long as a follow-up is
 * likely to come; a later one fails, its thread gone. A home is a few MB of Codex's own state,
 * which would otherwise pile up a task at a time.
 */
const CODEX_HOME_KEPT_MS = 14 * 24 * 60 * 60_000;

/**
 * Signal an agent's whole process group: the CLI and every tool it started. Each agent leads its
 * own group (`detached`), so a runner that exits takes them all down, and a Ctrl-C at the
 * runner's terminal reaches them only through the runner. A group already gone is nothing to do.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;

  try {
    process.kill(-child.pid, signal);
  } catch {
    // Exited, with everything it started.
  }
}

/** This process's env without ky's own variables, which are the runner's and never a task's. */
function outsideEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("KY_")));
}

/**
 * Sign a Codex home in with ky's ChatGPT login, as `codex login` writes auth.json: owner-only,
 * and swapped in whole by a rename, so Codex never reads half of it. It has no refresh token: ky
 * refreshes the login and sends the new one to the task.
 */
function writeCodexAuth(home: string, codex: CodexCreds): void {
  const auth = {
    OPENAI_API_KEY: null,
    tokens: { id_token: codex.idToken, access_token: codex.accessToken, refresh_token: "", account_id: codex.accountId },
    last_refresh: new Date().toISOString()
  };

  const temporary = join(home, `auth.json.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(auth), { mode: 0o600 });
  renameSync(temporary, join(home, "auth.json"));
}

export function tasks(config: TaskConfig) {
  const codexHomes = join(config.state, "codex");
  const bin = join(config.state, "bin");
  const prompt = taskPrompt(config.workdir);
  /** Each agent still running, or with a tool still holding its output open, and when it closes. */
  const live = new Map<ChildProcess, Promise<void>>();

  /** Puts `ky` where each task finds it on its PATH: this `ky`, whichever its user runs. */
  function installKy(): void {
    mkdirSync(bin, { recursive: true });
    const file = join(bin, "ky");
    writeFileSync(file, `#!/bin/sh\nexec ${config.ky.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(" ")} "$@"\n`);
    chmodSync(file, 0o755);
  }

  function linkMachineAuth(home: string): void {
    try {
      symlinkSync(join(config.machineCodexHome, "auth.json"), join(home, "auth.json"));
    } catch (error) {
      // Linked by an earlier turn.
      // SAFETY: symlinkSync throws only system errors, each with a code.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  /**
   * A Codex task's own CODEX_HOME, which keeps its threads for follow-ups to resume. Nothing of
   * the user's own Codex config (models, MCP servers, profiles) comes in, and its threads stay out
   * of the user's history.
   *
   * It signs in with the machine's login: auth.json links to the machine's, so a token Codex
   * refreshes is refreshed for both. Or, when ky sent a ChatGPT login, with that: auth.json is a
   * file of it in place of the link, deleted when the turn's process exits (`signOut`). Each turn
   * marks the home used, for the sweep.
   */
  function codexHome(task: string, codex: CodexCreds | undefined): string {
    const home = join(codexHomes, task);
    mkdirSync(home, { recursive: true, mode: 0o700 });

    if (codex) writeCodexAuth(home, codex);
    else linkMachineAuth(home);

    const now = new Date();
    utimesSync(home, now, now);

    return home;
  }

  /** Delete ky's ChatGPT login from a Codex home once its turn's process exits; the next turn brings its own. */
  function signOut(task: string): void {
    rmSync(join(codexHomes, task, "auth.json"), { force: true });
  }

  /** The tasks with a Codex home: none while there is no folder for them, or one it cannot read. */
  function codexHomeTasks(): string[] {
    try {
      return readdirSync(codexHomes);
    } catch (error) {
      // SAFETY: readdirSync throws only system errors, each with a code.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") config.log(`could not list the Codex homes: ${String(error)}`);

      return [];
    }
  }

  /**
   * Delete each Codex task's home not used for CODEX_HOME_KEPT_MS. It runs with the facts, so it
   * never throws: a home gone since the listing, or one it cannot read, is left for the next sweep.
   */
  function sweepCodexHomes(): void {
    for (const task of codexHomeTasks()) {
      const home = join(codexHomes, task);

      try {
        // lstat: a home is a folder, and a link in its place is judged by its own age, not followed.
        if (Date.now() - lstatSync(home).mtimeMs <= CODEX_HOME_KEPT_MS) continue;
        rmSync(home, { recursive: true, force: true });
        config.log(`${task}: deleted its Codex home, unused for ${CODEX_HOME_KEPT_MS / 86_400_000} days`);
      } catch (error) {
        config.log(`${task}: could not sweep its Codex home: ${String(error)}`);
      }
    }
  }

  /**
   * How each agent's CLI is started for a task: its executable, arguments, and what it adds to
   * the environment. ky's Claude subscription goes into this one child's env only, as the Claude
   * Code CLI reads it.
   */
  const launches: Record<Agent, (task: string, session: string | null, creds: RunCreds | undefined) => { command: string; args: string[]; env: Record<string, string> }> = {
    claude: (_task, session, creds) => ({
      command: config.claude,
      args: claudeArgs({ permissionMode: config.permissionMode, systemPrompt: prompt + (config.chrome ? CHROME_PROMPT : ""), chrome: config.chrome, session }),
      env: { ...(creds?.claude && { CLAUDE_CODE_OAUTH_TOKEN: creds.claude.oauthToken }) }
    }),
    codex: (task, session, creds) => ({ command: config.codex, args: codexArgs(session, prompt), env: { CODEX_HOME: codexHome(task, creds?.codex) } })
  };

  /**
   * Start a task's agent in the work dir. If its work dir or Codex home cannot be made (EPERM,
   * ENOSPC), it exits at once with why, as a CLI that would not start does, and its turn ends
   * failed: the run was already acked.
   */
  const spawnAgent: SpawnAgent = (agent: Agent, task: string, { taskToken, session, creds }: Launch, events: ProcessEvents): AgentProcess => {
    let launch: ReturnType<(typeof launches)[Agent]>;
    // Only a home ky signed in has a login of ky's to delete; the link to the machine's stays.
    const handed = agent === "codex" && creds?.codex !== undefined;

    try {
      mkdirSync(config.workdir, { recursive: true });
      launch = launches[agent](task, session, creds);
    } catch (error) {
      if (handed) signOut(task);
      // After this returns: the runner records the process before it hears it exit.
      setImmediate(() => events.exit(null, `It could not start: ${String(error)}`));

      return { write: () => {}, end: () => {}, interrupt: () => {}, renew: () => {}, pid: undefined, stderr: () => "" };
    }

    const { command, args, env } = launch;

    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
      cwd: config.workdir,
      // Its own process group, which signalGroup ends whole.
      detached: true,
      // C1's env, for either agent: where ky is, which task this is, and the task's own token. Never a
      // GitHub token of ky's: the cloud machine reaches GitHub through github.internal, which holds it.
      env: {
        ...outsideEnv(),
        ...env,
        KY_URL: config.url,
        KY_TASK: task,
        KY_TASK_TOKEN: taskToken,
        PATH: `${bin}:${process.env.PATH ?? ""}`
      }
    });

    live.set(child, new Promise((resolve) => child.once("close", () => resolve())));
    createInterface({ input: child.stdout }).on("line", (line) => events.line(line));
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("close", (code, signal) => {
      live.delete(child);

      if (handed) signOut(task);

      // A CLI that could not be started (ENOENT, EACCES) says only why.
      if (spawnError) events.exit(null, `It could not start: ${String(spawnError)}`);
      else events.exit(code, stderr, signal);
    });
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      if (child.pid === undefined) spawnError = error;
      else stderr += String(error);
    });

    return {
      write: (text) => {
        child.stdin.write(text);
      },
      end: () => {
        child.stdin.end();
      },
      interrupt: () => {
        signalGroup(child, "SIGINT");
        setTimeout(() => signalGroup(child, "SIGKILL"), 5_000).unref();
      },
      renew: (codex) => {
        if (handed) writeCodexAuth(join(codexHomes, task), codex);
      },
      pid: child.pid,
      stderr: () => stderr
    };
  };

  /**
   * Wait up to `withinMs` for every agent to close, then SIGKILL the groups of those that haven't,
   * so the runner exits after its agents, never before. Call it once they are interrupted.
   */
  async function settle(withinMs: number): Promise<void> {
    await closed(withinMs);

    for (const child of live.keys()) {
      config.log(`pid ${child.pid} did not exit within ${withinMs / 1000}s of its interrupt; killing its process group`);
      signalGroup(child, "SIGKILL");
    }

    // A tool that left the group could hold the output open for ever; a SIGKILLed group closes at once.
    await closed(1_000);
  }

  /** Every agent closed, or `ms` passed. */
  async function closed(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(live.values()), new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  }

  return { installKy, sweepCodexHomes, spawnAgent, settle };
}
