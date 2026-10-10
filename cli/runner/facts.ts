/**
 * What a runner finds out about its machine: whether `claude` and `codex` are here and signed
 * in, its git repositories, the user's Chrome, and which local model servers answer. `ky runner
 * add` asks it once, to offer what to share; `ky runner run` keeps the machine's facts (C1) fresh
 * with it, for every hello.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { basename, join } from "node:path";
import Type from "typebox";
import { Value } from "typebox/value";
import type { Agent, MachineFacts } from "../../src/runner-protocol.ts";

export type AgentFacts = MachineFacts["agents"][Agent];

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
 * Whether an agent's CLI runs here, and is signed in, as its status command says: `signedIn`
 * reads what it printed and how it exited. Undefined if it says nothing readable in time.
 */
function askAgent(command: string, args: string[], signedIn: (out: string, code: number | null) => boolean | undefined): Promise<AgentFacts | undefined> {
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

/** Each agent's status command, given its executable. */
export const ASK: Record<Agent, (command: string) => Promise<AgentFacts | undefined>> = {
  // No `--json`: JSON is its default, and a CLI without the flag still answers by its exit code.
  claude: (command) => askAgent(command, ["auth", "status"], (out, code) => loggedIn(out) ?? SIGNED_IN_BY_EXIT.get(code ?? -1)),
  // It says which login in words, on stderr; its exit code is what to read.
  codex: (command) => askAgent(command, ["login", "status"], (_out, code) => SIGNED_IN_BY_EXIT.get(code ?? -1))
};

/** How long the repo list and agent logins are kept before the next hello checks again. */
export const FACTS_EVERY_MS = 5 * 60_000;

/** Whether `command` is not on this machine. */
function missing(command: string): boolean {
  // SAFETY: spawnSync's error is a system error, with a code.
  return (spawnSync(command, ["--version"], { stdio: "ignore", timeout: 10_000 }).error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * An agent's facts as last known, asked again in the background once they are old: an answer
 * that says nothing keeps the last one. Before any answer it is taken to be here and signed out.
 * One last found missing is looked for again each time, since a run for it is turned away and it
 * may have been installed since; that check is quick.
 */
export function lastKnown(command: string, ask: () => Promise<AgentFacts | undefined>) {
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

/**
 * The `origin` URL in a repository's `.git/config`, without any credentials in it, or null (no
 * origin, or `.git` is a worktree file).
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

/** Each git repository in `roots`: a folder that is one, and the folders right inside it that are. */
export function scanRepos(roots: readonly string[]): MachineFacts["repos"] {
  return roots
    .flatMap(foldersIn)
    .filter((folder) => existsSync(join(folder, ".git")))
    .slice(0, 100)
    .map((folder) => ({ name: basename(folder), remote: originOf(folder) }));
}

/** Folders people keep repositories in, under their home. */
const REPO_FOLDERS = ["code", "Code", "src", "dev", "Developer", "projects", "Projects", "repos", "git", "work", "ky-work"];

/** The folders under `home` that hold git repositories, with how many each holds. */
export function repoFolders(home: string): { folder: string; repos: number }[] {
  // On a disk that ignores case, code and Code are one folder, which the real path names once.
  const folders = new Map<string, string>();

  for (const folder of REPO_FOLDERS.map((name) => join(home, name))) {
    if (existsSync(folder) && !folders.has(realpathSync.native(folder))) folders.set(realpathSync.native(folder), folder);
  }

  return [...folders.values()].flatMap((folder) => {
    const repos = scanRepos([folder]).length;

    return repos > 0 ? [{ folder, repos }] : [];
  });
}

/** Whether Chrome is installed, for Claude in Chrome. */
export function hasChrome(platform: NodeJS.Platform, home: string): boolean {
  if (platform === "darwin") return ["/Applications/Google Chrome.app", join(home, "Applications", "Google Chrome.app")].some((app) => existsSync(app));

  return ["google-chrome", "google-chrome-stable", "chromium"].some((command) => !missing(command));
}

/** Whether something listens on `port` on this machine. */
export function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 1_000 });

    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };

    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}
