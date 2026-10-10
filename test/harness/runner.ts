import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { signedIn } from "../../src/tests/fake-access.ts";
import { REPO } from "./stack.ts";

/**
 * The real runner (`ky runner run`) as its own process, with the fake
 * claude and codex (test/fakes/) as KY_CLAUDE and KY_CODEX and a throwaway
 * HOME, config and workdir, so it never touches the user's ~/.ky, ~/.codex,
 * ~/ky-work, Keychain or machine token. It pairs as the user does: a code
 * from ky, then `ky runner add --yes --no-service`, its token in a file
 * (KY_RUNNER_TOKEN_FILE), so no Keychain and no launchd agent.
 */

export const FAKE_CLAUDE = path.join(REPO, "test/fakes/claude.ts");

export const FAKE_CODEX = path.join(REPO, "test/fakes/codex.ts");

/** `ky`: this checkout's cli/main.ts, or the compiled binary KY_HARNESS_KY names. */
export const KY_COMMAND: readonly string[] = process.env.KY_HARNESS_KY
  ? [process.env.KY_HARNESS_KY]
  : [process.execPath, "--experimental-strip-types", "--no-warnings", path.join(REPO, "cli/main.ts")];

const [KY, ...KY_ARGS] = KY_COMMAND;

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
  instructions: Type.Optional(Type.Number()),
  /** A fingerprint of the token it signed in with: claude's CLAUDE_CODE_OAUTH_TOKEN at its start, codex's auth.json at its start and exit; "" for none. */
  token: Type.Optional(Type.String()),
  /** The names of the KY_ variables the CLI was started with. */
  ky: Type.Optional(Type.String())
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
  /** Where its machine token is kept, in its HOME. */
  tokenFile: string;
  /** Run `ky runner add` with `code`, as the user does: its exit code and what it logged. */
  pair: (url: string, code: string) => Promise<{ code: number; output: string }>;
  /** What every fake claude on this machine has done, in order. */
  claude: () => FakeEvent[];
  /** What every fake codex on this machine has done, in order. */
  codex: () => FakeEvent[];
  launch: (url: string, env?: Record<string, string>) => Runner;
};

/** A pairing code, as the signed-in user makes one in Settings. */
export async function pairingCode(url: string): Promise<string> {
  const response = await fetch(`${url}/api/runners/codes`, { method: "POST", headers: await signedIn() });

  if (!response.ok) throw new Error(`/api/runners/codes answered ${response.status}`);

  // SAFETY: a 200 from /api/runners/codes is { code, expiresAt }.
  return ((await response.json()) as { code: string }).code;
}

/** A machine: a name and a directory for its HOME, workdir, logs and fake claude and codex logs. */
export function machine(name: string, root: string): Machine {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "home"), { recursive: true });
  const claudeLog = path.join(dir, "claude.jsonl");
  const codexLog = path.join(dir, "codex.jsonl");
  const home = path.join(dir, "home");
  const tokenFile = path.join(home, ".config", "ky", "runner-token");
  let launches = 0;

  /** The machine's computer: its HOME, config, state, token file and fake agents. */
  const computer = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    KY_MACHINE: name,
    KY_RUNNER_TOKEN_FILE: tokenFile,
    // No ports unless a scenario gives some, whatever listens on this computer when it pairs.
    KY_RUNNER_PORTS: "",
    // The runner's state dir (default ~/.ky), kept with the machine so a relaunch finds it and the user's is never touched.
    KY_STATE_DIR: path.join(dir, "state"),
    KY_CLAUDE: FAKE_CLAUDE,
    FAKE_CLAUDE_LOG: claudeLog,
    KY_CODEX: FAKE_CODEX,
    FAKE_CODEX_LOG: codexLog
  };

  const pair = (url: string, code: string) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      execFile(
        KY!,
        [...KY_ARGS, "runner", "add", url, code, "--yes", "--no-service"],
        { cwd: dir, env: { ...computer, KY_WORKDIR: path.join(dir, "work") } },
        (error, stdout, stderr) => resolve({ code: error === null ? 0 : Number(error.code ?? 1), output: `${stdout}${stderr}` })
      );
    });

  const launch = (url: string, env: Record<string, string> = {}): Runner => {
    launches++;
    const logFile = path.join(dir, `runner-${launches}.log`);
    const out = createWriteStream(logFile);

    const child: ChildProcess = spawn(KY!, [...KY_ARGS, "runner", "run"], {
      cwd: dir,
      env: { ...computer, KY_URL: url, KY_WORKDIR: path.join(dir, "work"), ...env },
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

  return { name, dir, tokenFile, pair, claude: () => eventsIn(claudeLog), codex: () => eventsIn(codexLog), launch };
}
