/**
 * What the runner commands ask of the computer they run on: where its user keeps things, and the
 * programs they run (`security`, `launchctl`, `systemctl`). The tests hand them a temporary home
 * and fakes of those programs, so nothing touches the user's real Keychain, launchd agents or
 * config.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { hasChrome, listening } from "./facts.ts";

/** What a program printed and how it exited; `code` is 127 when it isn't there. */
export type Ran = { code: number; stdout: string; stderr: string };

/** Run `command` with `args`, writing `input` to its stdin. */
export type Exec = (command: string, args: string[], input?: string) => Promise<Ran>;

export type System = {
  platform: NodeJS.Platform;
  home: string;
  user: string;
  uid: number;
  /** ~/.config, or XDG_CONFIG_HOME. */
  config: string;
  /** Where the runner keeps its state, its log and the `ky` its tasks run: KY_STATE_DIR, else ~/.ky. */
  state: string;
  /** The service's label (launchd) or unit name (systemd). */
  label: string;
  /** Where launchd agents' plists go. */
  launchAgents: string;
  /** Where systemd user units go. */
  systemdUnits: string;
  /** The command line that runs this `ky`. */
  ky: string[];
  /** PATH as this shell has it, for the service, so it finds `claude` and `codex`. */
  path: string;
  exec: Exec;
  /** Whether something listens on a port on this machine. */
  listening: (port: number) => Promise<boolean>;
  /** Whether Chrome is installed, for Claude in Chrome. */
  chrome: () => boolean;
};

/** Runs `command`, never throwing: a missing program is code 127. */
const exec: Exec = (command, args, input) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => resolve({ code: error.code === "ENOENT" ? 127 : 1, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

/** Whether this is the compiled `ky` (cli/binary.ts), whose release and code are inside the binary. */
export function compiled(): boolean {
  return import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");
}

/** Homebrew's versioned path for ky, `<prefix>/Cellar/ky/<version>/bin/ky`: its prefix. */
const CELLAR = /^(.+)\/Cellar\/ky\/[^/]+\/bin\/ky$/;

/**
 * The path that keeps running this binary across upgrades: the first `ky` on `PATH` that resolves to `binary`,
 * such as Homebrew's /opt/homebrew/bin/ky, a link into /opt/homebrew/Cellar/ky/<version>/bin/ky that `brew
 * upgrade` deletes. With none on `PATH`, a Cellar path's `<prefix>/bin/ky` when it is there; else `binary` itself.
 */
export function stableKy(binary: string, PATH: string): string {
  const real = (file: string) => {
    try {
      return realpathSync(file);
    } catch {
      return undefined;
    }
  };

  const target = real(binary) ?? binary;

  const onPath = PATH.split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, "ky"))
    .find((candidate) => real(candidate) === target);

  if (onPath) return onPath;
  const prefix = (CELLAR.exec(binary) ?? CELLAR.exec(target))?.[1];
  const linked = prefix && path.join(prefix, "bin", "ky");

  return linked && real(linked) ? linked : binary;
}

/** The command line that runs this `ky`: the binary itself, or Node on this checkout's cli/main.ts. */
function kyCommand(): string[] {
  if (compiled()) return [stableKy(process.execPath, process.env.PATH ?? "")];

  return [process.execPath, "--experimental-strip-types", "--no-warnings", path.join(import.meta.dirname, "..", "main.ts")];
}

/** The computer `ky` runs on. */
export function system(): System {
  const home = homedir();

  return {
    platform: process.platform,
    home,
    user: userInfo().username,
    uid: process.getuid?.() ?? 0,
    config: process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
    state: process.env.KY_STATE_DIR ?? path.join(home, ".ky"),
    label: process.platform === "darwin" ? "dev.ky.runner" : "ky-runner",
    launchAgents: path.join(home, "Library", "LaunchAgents"),
    systemdUnits: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user"),
    ky: kyCommand(),
    path: process.env.PATH ?? "/usr/bin:/bin",
    exec,
    listening,
    chrome: () => hasChrome(process.platform, home)
  };
}
