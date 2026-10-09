#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ky's machine runner. Run it on a computer you want ky to use: it dials
 * into your agent over a WebSocket and runs each task as a Claude Code or
 * Codex session on this machine, with your own `claude` or `codex` login,
 * shell, files and browser. Nothing listens on a port.
 *
 *   KY_URL=https://ky.<you>.workers.dev KY_TOKEN=... node runner/ky-runner.ts
 *
 * KY_TOKEN_FILE   read KY_TOKEN from this file instead
 * KY_MACHINE      name shown in ky (default: this host's name)
 * KY_WORKDIR      where tasks run (default: ~/ky-work)
 * KY_PERMISSION_MODE  Claude Code permission mode (default: bypassPermissions)
 * KY_CLAUDE       the claude executable (default: claude)
 * KY_CODEX        the codex executable (default: codex)
 * KY_CHROME       1: tasks drive the user's Chrome, with its logins (Claude in Chrome)
 * KY_REPOS        folders, split by ":", whose git repositories ky is told about (default: KY_WORKDIR)
 * KY_STATE_DIR    what must outlive the runner, and each Codex task's home (default: ~/.ky)
 *
 * Each task finds two commands on its PATH: ky-attach shares an image or
 * video, and ky-diff shares a repository's changes as a reviewable diff.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import Type from "typebox";
import { Value } from "typebox/value";
import { OUTDATED, REPLACED, RUNNER_PATH, type Agent, type MachineFacts } from "../src/runner-protocol.ts";
import { claudeArgs } from "./claude.ts";
import { codexArgs } from "./codex.ts";
import { HandledSeqs } from "./handled.ts";
import { Runner, type AgentProcess, type Link, type ProcessEvents } from "./runner.ts";

const URL_BASE = required("KY_URL").replace(/\/$/, "");

const TOKEN = process.env.KY_TOKEN_FILE
  ? readFileSync(process.env.KY_TOKEN_FILE, "utf8").trim()
  : required("KY_TOKEN");

const MACHINE = (process.env.KY_MACHINE ?? hostname().split(".")[0]!)
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-")
  .slice(0, 32);

const WORKDIR = process.env.KY_WORKDIR ?? join(homedir(), "ky-work");

const PERMISSION_MODE = process.env.KY_PERMISSION_MODE ?? "bypassPermissions";

const CLAUDE = process.env.KY_CLAUDE ?? "claude";

const CODEX = process.env.KY_CODEX ?? "codex";

/** Where the machine's own Codex keeps its login. */
const MACHINE_CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");

const CHROME = process.env.KY_CHROME === "1";

const REPO_ROOTS = (process.env.KY_REPOS ?? WORKDIR).split(":").filter((root) => root !== "");

/** Where the runner keeps what must outlive it: the seqs of the commands it has run, and each Codex task's home. */
const STATE_DIR = process.env.KY_STATE_DIR ?? join(homedir(), ".ky");

/** Where `ky-attach` is installed; each task finds it on its PATH. */
const BIN = join(homedir(), ".ky", "bin");

/** Playwright and Chromium for captures, installed on first use outside any repo. */
const CAPTURE = join(WORKDIR, ".capture");

// ky-attach <file> [caption]: shows an image or video in ky, on this task and in its report.
const ATTACH = `#!/usr/bin/env node
const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".webm": "video/webm", ".mp4": "video/mp4" };
const [path, caption] = process.argv.slice(2);
(async () => {
  const { readFile } = await import("node:fs/promises");
  const { basename, extname } = await import("node:path");
  if (!path) throw new Error("usage: ky-attach <file> [caption]");
  const { KY_URL, KY_TOKEN, KY_TASK } = process.env;
  if (!KY_URL || !KY_TOKEN || !KY_TASK) throw new Error("run this inside a ky task");
  const type = types[extname(path).toLowerCase()];
  if (!type) throw new Error("png, jpeg, webp, gif, webm or mp4 only");
  const headers = { "content-type": type, authorization: "Bearer " + KY_TOKEN,
    "x-ky-name": encodeURIComponent(basename(path)) };
  if (caption) headers["x-ky-caption"] = encodeURIComponent(caption);
  const url = KY_URL.replace(/\\/$/, "") + "/api/files?task=" + encodeURIComponent(KY_TASK);
  const response = await fetch(url, { method: "PUT", headers, body: await readFile(path) });
  if (!response.ok) throw new Error("HTTP " + response.status + ": " + (await response.text()).trim());
  console.log("Attached: " + basename(path));
})().catch((error) => { console.error("ky-attach: " + error.message); process.exitCode = 1; });
`;

/** Added to the agent's own instructions in every task: Claude Code's system prompt, Codex's developer instructions. */
const TASK_PROMPT = `You are running a task for ky, the user's agent; the user reads the result in ky, often on a phone.

To show the user a screenshot, a recording or a chart, attach it: ky-attach <file> [caption] (png, jpeg, webp, gif, webm or mp4, at most 25 MB). It appears on this task and in its report. Attach every image or video you make for the user, and mention it in your answer.
- For web pages use Playwright. The first time, install it in ${CAPTURE}: mkdir -p ${CAPTURE} && cd ${CAPTURE} && echo '{"private":true}' > package.json && npm install playwright && npx playwright install chromium. Run capture scripts from there.
- Screenshot at a 390x844 viewport unless asked otherwise. Record video with the browser context option recordVideo: { dir, size }; the webm is saved when the context closes.
- Save captures under ${join(WORKDIR, ".captures")}, never inside a repository.

When you change code in a git repository, run ky-diff from inside it before you answer, and again after any later change: the user sees the changes on this task and can comment on lines. It shares everything since the branch left the default branch; pass a commit (ky-diff <base>) to start elsewhere.`;

/** Added for Claude Code with KY_CHROME, which gives it the user's Chrome. */
const CHROME_PROMPT = `

For anything that needs the user's logins, use the user's own Chrome through the Claude in Chrome tools; Playwright starts logged out. Never read, copy or report passwords, cookies or tokens.`;

// ky-diff [base]: shares the repository's changes; the logic is runner/ky-diff.ts in this checkout.
const DIFF = `#!/bin/sh
exec "${process.execPath}" --experimental-strip-types --no-warnings "${join(import.meta.dirname, "ky-diff.ts")}" "$@"
`;

function installTools() {
  mkdirSync(BIN, { recursive: true });

  for (const [name, script] of [["ky-attach", ATTACH], ["ky-diff", DIFF]] as const) {
    const file = join(BIN, name);
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
}

/**
 * The `origin` URL in a repository's `.git/config`, without any credentials
 * in it, or null (no origin, or `.git` is a worktree file).
 */
function originOf(repo: string): string | null {
  try {
    const config = readFileSync(join(repo, ".git", "config"), "utf8");
    const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1];

    return url ? url.replace(/\/\/[^/@]*@/, "//") : null;
  } catch {
    return null;
  }
}

/** A root and the visible folders right inside it; none if it cannot be read. */
function foldersIn(root: string): string[] {
  try {
    const inside = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));

    return [root, ...inside.map((entry) => join(root, entry.name))];
  } catch {
    return [];
  }
}

/** Each git repository in KY_REPOS: a folder that is one, and the folders right inside it that are. */
function scanRepos(): MachineFacts["repos"] {
  return REPO_ROOTS.flatMap(foldersIn)
    .filter((folder) => existsSync(join(folder, ".git")))
    .slice(0, 100)
    .map((folder) => ({ name: basename(folder), remote: originOf(folder) }));
}

type AgentFacts = MachineFacts["agents"][Agent];

/** The part of `claude auth status`'s JSON the runner reads. */
const AuthStatus = Type.Object({ loggedIn: Type.Boolean() });

/** What `claude auth status` and `codex login status` exit with, signed in or not. */
const SIGNED_IN_BY_EXIT = new Map([
  [0, true],
  [1, false]
]);

/** `loggedIn` from `claude auth status`'s JSON; undefined for an older CLI's text. */
function loggedIn(out: string): boolean | undefined {
  try {
    const status = JSON.parse(out);

    return Value.Check(AuthStatus, status) ? status.loggedIn : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether an agent's CLI runs here, and is signed in, as its status
 * command says: `signedIn` reads what it printed and how it exited.
 * Undefined if it says nothing readable in time.
 */
function askAgent(
  command: string,
  args: string[],
  signedIn: (out: string, code: number | null) => boolean | undefined
): Promise<AgentFacts | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    let out = "";

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "ENOENT" ? { installed: false, signedIn: false } : undefined);
    });
    child.on("close", (code) => {
      // A timeout's kill leaves no code.
      const answer = signedIn(out, code);

      resolve(answer === undefined ? undefined : { installed: true, signedIn: answer });
    });
  });
}

/** How long the repo list and agent logins are kept before the next hello checks again. */
const FACTS_EVERY_MS = 5 * 60_000;

/**
 * An agent's facts as last known, asked again in the background once they
 * are old: an answer that says nothing keeps the last one. Before any answer
 * it is taken to be here and signed out. One last found missing is looked
 * for again each time, since a run for it is turned away and it may have
 * been installed since; that check is quick.
 */
function lastKnown(command: string, ask: () => Promise<AgentFacts | undefined>) {
  let facts: AgentFacts = { installed: true, signedIn: false };
  let at = 0;
  let check: Promise<void> | undefined;

  return {
    facts(): AgentFacts {
      if (!facts.installed && !missing(command)) {
        facts = { installed: true, signedIn: false };
        at = 0;
      }

      return facts;
    },
    refresh(): Promise<void> {
      if (!check && Date.now() - at > FACTS_EVERY_MS) {
        check = ask().then((answer) => {
          if (answer) facts = answer;
          at = Date.now();
          check = undefined;
        });
      }

      return check ?? Promise.resolve();
    }
  };
}

/** Whether `command` is not on this machine. */
function missing(command: string): boolean {
  // SAFETY: spawnSync's error is a system error, with a code.
  return (spawnSync(command, ["--version"], { stdio: "ignore", timeout: 10_000 }).error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

const AGENTS = {
  // No `--json`: JSON is its default, and a CLI without the flag still answers by its exit code.
  claude: lastKnown(CLAUDE, () => askAgent(CLAUDE, ["auth", "status"], (out, code) => loggedIn(out) ?? SIGNED_IN_BY_EXIT.get(code ?? -1))),
  // It says which login in words, on stderr; its exit code is what to read.
  codex: lastKnown(CODEX, () => askAgent(CODEX, ["login", "status"], (_out, code) => SIGNED_IN_BY_EXIT.get(code ?? -1)))
} satisfies Record<Agent, ReturnType<typeof lastKnown>>;

let repos: { at: number; value: MachineFacts["repos"] } | undefined;

/** What this machine is, for ky to choose where work goes; checked at most every few minutes. */
function machineFacts(): MachineFacts {
  for (const agent of Object.values(AGENTS)) void agent.refresh();

  if (!repos || Date.now() - repos.at > FACTS_EVERY_MS) {
    repos = { at: Date.now(), value: scanRepos() };
    sweepCodexHomes();
  }

  return {
    os: process.platform,
    chrome: CHROME,
    repos: repos.value,
    agents: { claude: AGENTS.claude.facts(), codex: AGENTS.codex.facts() },
    ports: [],
    kind: "computer"
  };
}

/** This checkout's commit, the runner's version until it ships as a binary. */
function version(): string {
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" });

  return head.status === 0 ? head.stdout.trim() : "unknown";
}

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    console.error(`Set ${name}.`);
    process.exit(1);
  }

  return value;
}

function log(...parts: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

/** Where each Codex task's home is. */
const CODEX_HOMES = join(STATE_DIR, "codex");

/**
 * How long a Codex task's home is kept after its last turn: two weeks, as
 * long as a follow-up is likely to come; a later one fails, its thread gone.
 * A home is a few MB of Codex's own state, which would otherwise pile up a
 * task at a time.
 */
const CODEX_HOME_KEPT_MS = 14 * 24 * 60 * 60_000;

/**
 * A Codex task's own CODEX_HOME, which keeps its threads for follow-ups to
 * resume. Nothing of the user's own Codex config (models, MCP servers,
 * profiles) comes in, and its threads stay out of the user's history. It
 * signs in with the machine's login: auth.json links to the machine's, so a
 * token Codex refreshes is refreshed for both. Each turn marks it used, for
 * the sweep.
 */
function codexHome(task: string): string {
  const home = join(CODEX_HOMES, task);
  mkdirSync(home, { recursive: true, mode: 0o700 });

  try {
    symlinkSync(join(MACHINE_CODEX_HOME, "auth.json"), join(home, "auth.json"));
  } catch (error) {
    // Linked by its first turn.
    // SAFETY: symlinkSync throws only system errors, each with a code.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const now = new Date();
  utimesSync(home, now, now);

  return home;
}

/**
 * Delete each Codex task's home not used for CODEX_HOME_KEPT_MS. It runs
 * with the facts, so it never throws: a home gone since the listing, or one
 * it cannot read, is left for the next sweep.
 */
function sweepCodexHomes(): void {
  let tasks: string[];

  try {
    tasks = readdirSync(CODEX_HOMES);
  } catch (error) {
    // SAFETY: readdirSync throws only system errors, each with a code.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`could not sweep the Codex homes: ${String(error)}`);

    return;
  }

  for (const task of tasks) {
    const home = join(CODEX_HOMES, task);

    try {
      // lstat: a home is a folder, and a link in its place is judged by its own age, not followed.
      if (Date.now() - lstatSync(home).mtimeMs <= CODEX_HOME_KEPT_MS) continue;
      rmSync(home, { recursive: true, force: true });
      log(`${task}: deleted its Codex home, unused for ${CODEX_HOME_KEPT_MS / 86_400_000} days`);
    } catch (error) {
      log(`${task}: could not sweep its Codex home: ${String(error)}`);
    }
  }
}

/** How each agent's CLI is started for a task: its executable, arguments, and what it adds to the environment. */
const LAUNCH: Record<Agent, (task: string, session: string | null) => { command: string; args: string[]; env: Record<string, string> }> = {
  claude: (_task, session) => ({
    command: CLAUDE,
    args: claudeArgs({ permissionMode: PERMISSION_MODE, systemPrompt: TASK_PROMPT + (CHROME ? CHROME_PROMPT : ""), chrome: CHROME, session }),
    env: {}
  }),
  codex: (task, session) => ({ command: CODEX, args: codexArgs(session, TASK_PROMPT), env: { CODEX_HOME: codexHome(task) } })
};

/** Start a task's agent in the work dir. */
function spawnAgent(agent: Agent, task: string, session: string | null, events: ProcessEvents): AgentProcess {
  mkdirSync(WORKDIR, { recursive: true });
  const { command, args, env } = LAUNCH[agent](task, session);

  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd: WORKDIR,
    env: {
      ...process.env,
      ...env,
      KY_TOKEN: TOKEN,
      KY_TASK: task,
      PATH: `${BIN}:${process.env.PATH ?? ""}`
    }
  });

  createInterface({ input: child.stdout }).on("line", (line) => events.line(line));
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.on("close", (code) => events.exit(code, stderr));
  child.on("error", (error) => {
    stderr += String(error);
  });

  return {
    write: (text) => {
      child.stdin.write(text);
    },
    end: () => {
      child.stdin.end();
    },
    interrupt: () => {
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }
  };
}

const runner = new Runner(
  spawnAgent,
  (line) => log(line),
  new HandledSeqs(join(STATE_DIR, `handled-${MACHINE}.json`), `${URL_BASE} ${MACHINE}`),
  version(),
  machineFacts
);

/** Close codes after which retrying cannot help, and what to log before exiting. */
const FATAL = new Map<number | undefined, string>([
  [REPLACED, `another runner connected as ${MACHINE}; exiting. Give each machine its own KY_MACHINE.`],
  // Its goodbye, logged as it came, said which protocol ky speaks.
  [OUTDATED, "this ky-runner speaks another protocol than ky; exiting. Update it."]
]);

let socket: WebSocket | undefined;

let backoff = 1_000;

function connect() {
  const url = `${URL_BASE.replace(/^http/, "ws")}${RUNNER_PATH}${MACHINE}`;
  // SAFETY: Node's WebSocket (undici) takes headers as a non-standard option its types leave out.
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } } as any);

  const link: Link = {
    send: (text) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(text);

      return true;
    }
  };

  socket = ws;
  ws.addEventListener("open", () => {
    backoff = 1_000;
    log(`connected as ${MACHINE}, working in ${WORKDIR}`);
    runner.open(link);
  });
  ws.addEventListener("message", (event) => runner.message(String(event.data)));

  // Once per socket: Node fires only `error`, never `close`, when a connect fails.
  const lost = (code: number | undefined, reason = "") => {
    if (socket !== ws) return;
    socket = undefined;
    runner.closed(link);

    const fatal = FATAL.get(code);

    if (fatal) {
      log(fatal);
      runner.shutdown();
      process.exit(1);
    }

    // The reason tells a malformed report (1008) apart from a flaky network.
    log(`disconnected (${code ?? "error"}${reason ? `: ${reason}` : ""}), retrying in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };

  ws.addEventListener("close", (event) => lost(event.code, event.reason));
  ws.addEventListener("error", () => {
    lost(undefined);

    try {
      ws.close();
    } catch {
      // Never opened.
    }
  });
}

// Keep the socket alive through idle proxies.
setInterval(() => runner.keepalive(), 30_000);

process.on("SIGINT", () => {
  runner.shutdown();
  process.exit(0);
});

installTools();

// The first hello waits for the first answers, so it does not say signed out of a machine that is not.
await Promise.all(Object.values(AGENTS).map((agent) => agent.refresh()));

connect();
