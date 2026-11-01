#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * A fake `claude` for the runner: it speaks Claude Code's stream-json on
 * stdin and stdout, as `claude -p --input-format stream-json
 * --output-format stream-json` does, and does no work. The CLI harness and
 * the web e2e hand it to `ky runner run` as KY_CLAUDE.
 *
 * Each user message is one turn: an assistant message, a pause, then a
 * result `fake claude did: <prompt>`. Messages queue and run in order. With
 * --replay-user-messages it echoes each message as it takes it in, as Claude
 * Code does. The session id is new, or the one given with --resume. stdin
 * closing ends it once its turns are done. Each result carries the
 * process's totals so far, as Claude Code's do: one turn per result, and
 * COST_PER_TURN each. `claude auth status` says it is signed in, as the
 * runner asks for its facts, unless FAKE_CLAUDE_SIGNED_OUT is set: then it
 * says it is not, and without CLAUDE_CODE_OAUTH_TOKEN every turn fails as
 * Claude Code's do signed out.
 *
 * Directives in a prompt:
 *   [delay=MS]   this turn takes MS milliseconds (default FAKE_CLAUDE_DELAY_MS, else 50)
 *   [fold]       messages that come while this turn runs join it, as Claude Code
 *                takes a message sent mid-turn: one result answers them all
 *   [attach]     share a 1x1 PNG through `ky attach`, as a screenshot would be
 *   [diff]       change a scratch git repository and share it through `ky diff`:
 *                a.ts with one line changed and one added, and a new notes.md
 *   [fail]       the turn ends in an error result
 *   [sh] COMMAND everything after it runs in a shell in the task's directory, and
 *                the answer ends with its exit code and output
 *   [tools=Bash:pnpm test,Edit:src/x.ts]
 *                the assistant message also uses these tools, each with its
 *                one argument (Bash's command, a file tool's path)
 *
 * FAKE_CLAUDE_LOG      append one JSON line per start, turn, SIGINT and exit, so
 *                      a test can count and order what really ran; a start
 *                      records a fingerprint of CLAUDE_CODE_OAUTH_TOKEN, never
 *                      the token
 * FAKE_CLAUDE_SIGINT_MS on SIGINT, stop reading and exit after this long
 *                      (default 0), as Claude Code takes a moment to shut down
 * FAKE_CLAUDE_SESSIONS keep each session as Claude Code does, in
 *                      ~/.claude/projects/fake/<session>.jsonl, and refuse to
 *                      --resume one that isn't there, exiting 1 as Claude Code
 *                      does: the cloud machine must bring its sessions back
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { attach, pause, shell, toolsIn } from "./directives.ts";

const UserLine = Type.Object({
  type: Type.Literal("user"),
  message: Type.Object({ role: Type.Literal("user"), content: Type.String() })
});

const args = process.argv.slice(2);

const signedOut = process.env.FAKE_CLAUDE_SIGNED_OUT !== undefined;

if (args[0] === "auth") {
  process.stdout.write(`${JSON.stringify({ loggedIn: !signedOut })}\n`);
  process.exit(signedOut ? 1 : 0);
}

/** The subscription token ky handed this process, if any. */
const handed = process.env.CLAUDE_CODE_OAUTH_TOKEN;

/** Neither signed in nor handed a token: every turn fails as Claude Code's does. */
const unsigned = signedOut && handed === undefined;

const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;

const session = resume ?? crypto.randomUUID();

const replay = args.includes("--replay-user-messages");

const task = process.env.KY_TASK ?? "";

const defaultDelay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 50);

const sigintDelay = Number(process.env.FAKE_CLAUDE_SIGINT_MS ?? 0);

/** What each turn costs, in US dollars. */
const COST_PER_TURN = 0.01;

/** Turns answered by this process, for the totals on each result. */
let turns = 0;

let dying = false;

function record(event: string, fields: Record<string, string | number> = {}) {
  const log = process.env.FAKE_CLAUDE_LOG;

  if (log) appendFileSync(log, `${JSON.stringify({ event, task, session, pid: process.pid, at: Date.now(), ...fields })}\n`);
}

/** The stream-json events the runner reads from Claude Code. */
type StreamEvent =
  | { type: "system"; subtype: "init" }
  | { type: "user"; message: { role: "user"; content: string }; isReplay: true }
  | { type: "assistant"; message: { role: "assistant"; content: Part[] } }
  | {
      type: "result";
      subtype: "success" | "error_during_execution";
      is_error: boolean;
      result: string;
      num_turns: number;
      total_cost_usd: number;
    };

type Part = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, string> };

/** The tool uses a `[tools=...]` directive asks for. */
function toolUses(prompt: string): Part[] {
  return toolsIn(prompt).map(({ name, value }): Part => ({
    type: "tool_use",
    id: crypto.randomUUID(),
    name,
    input: { [name === "Bash" ? "command" : "file_path"]: value }
  }));
}

function emit(event: StreamEvent) {
  process.stdout.write(`${JSON.stringify({ ...event, session_id: session })}\n`);
}

async function diff(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "fake-repo-"));
  const run = (command: string, args: string[]) => promisify(execFile)(command, args, { cwd: repo });
  writeFileSync(join(repo, "a.ts"), "const a = 1;\nconst b = 2;\nexport { a };\n");
  await run("git", ["init", "-q"]);
  await run("git", ["add", "."]);
  await run("git", ["-c", "user.name=fake", "-c", "user.email=fake@example.com", "commit", "-qm", "start"]);
  writeFileSync(join(repo, "a.ts"), "const a = 1;\nconst b = 3;\nconst c = 4;\nexport { a };\n");
  writeFileSync(join(repo, "notes.md"), "hello\n");
  const { stdout } = await run("ky", ["diff", "HEAD"]);

  return stdout.trim();
}

/** What `[attach]` and `[diff]` shared, as the lines the turn's answer ends with. */
async function share(prompt: string): Promise<string> {
  const ran = await shell(prompt);

  const lines = [
    ...(prompt.includes("[attach]") ? [await attach()] : []),
    ...(prompt.includes("[diff]") ? [await diff()] : []),
    ...(ran === undefined ? [] : [ran])
  ];

  return lines.map((line) => `\n${line}`).join("");
}

/** Take a message in: a turn the test can see, and its echo. */
function take(prompt: string, fields: Record<string, number> = {}) {
  record("turn", { prompt, ...fields });

  if (replay) emit({ type: "user", message: { role: "user", content: prompt }, isReplay: true });
}

/** Messages read and not yet taken in. */
const waiting: string[] = [];

async function turn(prompt: string) {
  if (dying) return;
  take(prompt);
  emit({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: `working on: ${prompt}` }, ...toolUses(prompt)] }
  });

  await pause(prompt, defaultDelay);
  const folded = prompt.includes("[fold]") ? waiting.splice(0) : [];

  for (const each of folded) take(each, { folded: 1 });
  const shared = await share(prompt);

  if (dying) return;

  if (unsigned) answer("[fail]", "Not logged in · Please run /login");
  else answer(prompt, `fake claude did: ${[prompt, ...folded].join(" + ")}${shared}`);
}

/** End a turn with its one result. */
function answer(prompt: string, text: string) {
  const failed = prompt.includes("[fail]");
  turns += 1;
  emit({
    type: "result",
    subtype: failed ? "error_during_execution" : "success",
    is_error: failed,
    result: text,
    num_turns: turns,
    total_cost_usd: turns * COST_PER_TURN
  });
}

process.on("SIGINT", () => {
  dying = true;
  record("sigint");
  setTimeout(() => {
    record("exit", { code: 130 });
    process.exit(130);
  }, sigintDelay);
});

// Which of ky's variables the runner gave it, by name only: never a token's value.
record("start", {
  resume: resume ?? "",
  token: handed === undefined ? "" : createHash("sha256").update(handed).digest("hex").slice(0, 12),
  ky: Object.keys(process.env).filter((name) => /^(KY|AGENT)_/u.test(name)).sort().join(",")
});

if (process.env.FAKE_CLAUDE_SESSIONS) {
  const sessions = join(homedir(), ".claude", "projects", "fake");
  const kept = join(sessions, `${session}.jsonl`);

  if (resume !== undefined && !existsSync(kept)) {
    record("exit", { code: 1 });
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    process.exit(1);
  }

  mkdirSync(sessions, { recursive: true });
  appendFileSync(kept, `${JSON.stringify({ type: "start", at: Date.now() })}\n`);
}

emit({ type: "system", subtype: "init" });

let queue = Promise.resolve();

createInterface({ input: process.stdin })
  .on("line", (line) => {
    let parsed;

    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!Value.Check(UserLine, parsed) || dying) return;
    waiting.push(parsed.message.content);
    queue = queue.then(() => {
      // A folding turn may have taken it already.
      const next = waiting.shift();

      return next === undefined ? undefined : turn(next);
    });
  })
  .on("close", () => {
    void queue.then(() => {
      if (dying) return;
      record("exit", { code: 0 });
      process.exit(0);
    });
  });
