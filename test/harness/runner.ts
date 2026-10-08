import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { REPO, TOKEN } from "./stack.ts";

/**
 * The real runner (runner/ky-runner.ts) as its own process, with the fake
 * claude and codex (test/fakes/) as KY_CLAUDE and KY_CODEX and a throwaway
 * HOME and workdir, so it never touches the user's ~/.ky, ~/.codex or
 * ~/ky-work.
 */

const FAKE_CLAUDE = path.join(REPO, "test/fakes/claude.ts");

const FAKE_CODEX = path.join(REPO, "test/fakes/codex.ts");

/** What a fake agent CLI logged: a start, a turn, a SIGINT or an exit. */
const FakeEvent = Type.Object({
  event: Type.String(),
  task: Type.String(),
  session: Type.String(),
  pid: Type.Number(),
  at: Type.Number(),
  prompt: Type.Optional(Type.String()),
  resume: Type.Optional(Type.String()),
  code: Type.Optional(Type.Number()),
  /** Codex's start: its CODEX_HOME, where its auth.json links to, and whether it was given developer instructions. */
  home: Type.Optional(Type.String()),
  auth: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.Number())
});

export type FakeEvent = Static<typeof FakeEvent>;

/** The events in a fake CLI's log, in order. */
function eventsIn(log: string): FakeEvent[] {
  if (!existsSync(log)) return [];

  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const value = JSON.parse(line);

      return Value.Check(FakeEvent, value) ? [value] : [];
    });
}

export type Runner = {
  machine: string;
  /** Stop the runner the way a crash does: no goodbye, its claude orphaned. */
  kill: () => Promise<void>;
  /** Stop it with SIGINT, as Ctrl-C does. */
  stop: () => Promise<void>;
  /** Its exit code once it has exited by itself, else null. */
  exitCode: () => number | null;
  /** What it has logged so far. */
  output: () => string;
};

export type Machine = {
  name: string;
  dir: string;
  /** What every fake claude on this machine has done, in order. */
  claude: () => FakeEvent[];
  /** What every fake codex on this machine has done, in order. */
  codex: () => FakeEvent[];
  launch: (url: string, env?: Record<string, string>) => Runner;
};

/** A machine: a name and a directory for its HOME, workdir, logs and fake claude and codex logs. */
export function machine(name: string, root: string): Machine {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "home"), { recursive: true });
  const claudeLog = path.join(dir, "claude.jsonl");
  const codexLog = path.join(dir, "codex.jsonl");
  let launches = 0;

  const launch = (url: string, env: Record<string, string> = {}): Runner => {
    launches++;
    const logFile = path.join(dir, `runner-${launches}.log`);
    const out = createWriteStream(logFile);

    const child: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(REPO, "runner/ky-runner.ts")], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: path.join(dir, "home"),
        KY_URL: url,
        KY_TOKEN: TOKEN,
        KY_MACHINE: name,
        KY_WORKDIR: path.join(dir, "work"),
        // The runner's state dir (default ~/.ky), kept with the machine so a relaunch finds it and the user's is never touched.
        KY_STATE_DIR: path.join(dir, "state"),
        KY_CLAUDE: FAKE_CLAUDE,
        FAKE_CLAUDE_LOG: claudeLog,
        KY_CODEX: FAKE_CODEX,
        FAKE_CODEX_LOG: codexLog,
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout?.pipe(out);
    child.stderr?.pipe(out);

    const end = async (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill(signal);
      await exited;
    };

    return {
      machine: name,
      kill: () => end("SIGKILL"),
      stop: () => end("SIGINT"),
      exitCode: () => child.exitCode,
      output: () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "")
    };
  };

  return { name, dir, claude: () => eventsIn(claudeLog), codex: () => eventsIn(codexLog), launch };
}
