#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * A fake `codex` for the runner: it speaks `codex exec --json` as Codex
 * 0.160 does, and does no work. The CLI harness and the web e2e hand it to
 * runner/ky-runner.ts as KY_CODEX.
 *
 * `codex exec [resume <thread>] ... -` reads the prompt from stdin, runs
 * one turn on it and exits: the thread starts (new, or the one resumed), the
 * turn starts, each tool a directive asks for is an item, then after a pause
 * Codex's answer `fake codex did: <prompt>` and the turn's end.
 * `codex login status` says on stderr that it is signed in, as Codex does.
 *
 * Directives in a prompt:
 *   [delay=MS]   this turn takes MS milliseconds (default 50)
 *   [fail]       the turn fails, with the API's error body as Codex gives it
 *   [attach]     a command that shares a 1x1 PNG through `ky-attach`, run with
 *                the environment Codex gives its commands: unless
 *                shell_environment_policy.ignore_default_excludes=true, none
 *                named like a key, secret or token; the answer ends with what
 *                it printed, or how it failed
 *   [tools=Bash:pnpm test,Edit:src/x.ts]
 *                items before the answer: Bash a command, Write/Edit/Delete a file change
 *
 * FAKE_CODEX_LOG       append one JSON line per start, turn, SIGINT and exit, so
 *                      a test can count and order what really ran; a start
 *                      records its CODEX_HOME and where its auth.json links to
 */
import { appendFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { attach, toolsIn } from "./directives.ts";

const args = process.argv.slice(2);

if (args[0] === "login" && args[1] === "status") {
  process.stderr.write("Logged in using ChatGPT\n");
  process.exit(0);
}

const resume = args[1] === "resume" ? args.find((arg, index) => index > 1 && !arg.startsWith("-") && args[index - 1] !== "-c") : undefined;

const thread = resume ?? crypto.randomUUID();

const task = process.env.KY_TASK ?? "";

const home = process.env.CODEX_HOME ?? "";

let dying = false;

function record(event: string, fields: Record<string, string | number> = {}) {
  const log = process.env.FAKE_CODEX_LOG;

  if (log) appendFileSync(log, `${JSON.stringify({ event, task, session: thread, pid: process.pid, at: Date.now(), ...fields })}\n`);
}

type ToolItem =
  | { id: string; type: "command_execution"; command: string; aggregated_output: string; exit_code: number; status: string }
  | { id: string; type: "file_change"; changes: { path: string; kind: string }[]; status: string };

type Item = ToolItem | { id: string; type: "agent_message"; text: string };

type JsonEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "item.started" | "item.completed"; item: Item }
  | { type: "error"; message: string }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "turn.completed"; usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } };

function emit(event: JsonEvent) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Where the task's auth.json links to, or "" if it is not a link. */
function authLink(): string {
  try {
    return readlinkSync(join(home, "auth.json"));
  } catch {
    return "";
  }
}

const FILE_KINDS = new Map([
  ["Write", "add"],
  ["Edit", "update"],
  ["Delete", "delete"]
]);

/** The items a `[tools=...]` directive asks for. */
function items(prompt: string): ToolItem[] {
  return toolsIn(prompt).map(({ name, value }, index): ToolItem => {
    const id = `item_${index}`;

    return name === "Bash"
      ? { id, type: "command_execution", command: `/bin/zsh -lc '${value}'`, aggregated_output: "", exit_code: 0, status: "completed" }
      : { id, type: "file_change", changes: [{ path: value, kind: FILE_KINDS.get(name) ?? "update" }], status: "completed" };
  });
}

/** The environment Codex gives its commands: by default, none named like a key, secret or token. */
function commandEnv(): NodeJS.ProcessEnv {
  if (args.includes("shell_environment_policy.ignore_default_excludes=true")) return process.env;

  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN/i.test(name)));
}

/** `[attach]` as a command item: a line saying what it printed, or how it failed; nothing without the directive. */
async function attached(prompt: string): Promise<string> {
  if (!prompt.includes("[attach]")) return "";
  const item: ToolItem = { id: "item_attach", type: "command_execution", command: "/bin/zsh -lc 'ky-attach screenshot.png'", aggregated_output: "", exit_code: 0, status: "in_progress" };
  emit({ type: "item.started", item });

  try {
    const said = await attach(commandEnv());
    emit({ type: "item.completed", item: { ...item, aggregated_output: said, status: "completed" } });

    return `\n${said}`;
  } catch (error) {
    emit({ type: "item.completed", item: { ...item, aggregated_output: String(error), exit_code: 1, status: "failed" } });

    return `\nky-attach failed: ${String(error)}`;
  }
}

process.on("SIGINT", () => {
  dying = true;
  record("sigint");
  record("exit", { code: 130 });
  process.exit(130);
});

record("start", { resume: resume ?? "", home, auth: authLink(), instructions: args.some((arg) => arg.startsWith("developer_instructions=")) ? 1 : 0 });

let prompt = "";

process.stdin.on("data", (chunk) => {
  prompt += chunk;
});

process.stdin.on("end", async () => {
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "turn.started" });
  record("turn", { prompt });

  for (const item of items(prompt)) {
    emit({ type: "item.started", item: { ...item, status: "in_progress" } });
    emit({ type: "item.completed", item });
  }

  const delay = /\[delay=(\d+)\]/.exec(prompt);
  await new Promise((resolve) => setTimeout(resolve, delay ? Number(delay[1]) : 50));

  if (dying) return;

  if (prompt.includes("[fail]")) {
    const body = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "fake codex failed" } });
    emit({ type: "error", message: body });
    emit({ type: "turn.failed", error: { message: body } });
    record("exit", { code: 1 });
    process.exit(1);
  }

  const shared = await attached(prompt);
  emit({ type: "item.completed", item: { id: "item_answer", type: "agent_message", text: `fake codex did: ${prompt}${shared}` } });
  emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
  record("exit", { code: 0 });
  process.exit(0);
});
