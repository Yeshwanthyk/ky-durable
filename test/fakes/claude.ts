#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * A fake `claude` for the runner: it speaks Claude Code's stream-json on
 * stdin and stdout, as `claude -p --input-format stream-json
 * --output-format stream-json` does, and does no work. The CLI harness and
 * the web e2e hand it to runner/ky-runner.ts as KY_CLAUDE.
 *
 * Each user message is one turn: an assistant message, a pause, then a
 * result `fake claude did: <prompt>`. Messages queue and run in order. The
 * session id is new, or the one given with --resume. stdin closing ends it
 * once its turns are done.
 *
 * Directives in a prompt:
 *   [delay=MS]   this turn takes MS milliseconds (default FAKE_CLAUDE_DELAY_MS, else 50)
 *   [attach]     share a 1x1 PNG through `ky-attach`, as a screenshot would be
 *   [fail]       the turn ends in an error result
 *
 * FAKE_CLAUDE_LOG      append one JSON line per start, turn, SIGINT and exit, so
 *                      a test can count and order what really ran
 * FAKE_CLAUDE_SIGINT_MS on SIGINT, stop reading and exit after this long
 *                      (default 0), as Claude Code takes a moment to shut down
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";

const UserLine = Type.Object({
  type: Type.Literal("user"),
  message: Type.Object({ role: Type.Literal("user"), content: Type.String() })
});

/** A 1x1 transparent PNG. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

const args = process.argv.slice(2);

const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;

const session = resume ?? crypto.randomUUID();

const task = process.env.KY_TASK ?? "";

const defaultDelay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 50);

const sigintDelay = Number(process.env.FAKE_CLAUDE_SIGINT_MS ?? 0);

let dying = false;

function record(event: string, fields: Record<string, string | number> = {}) {
  const log = process.env.FAKE_CLAUDE_LOG;

  if (log) appendFileSync(log, `${JSON.stringify({ event, task, session, pid: process.pid, at: Date.now(), ...fields })}\n`);
}

/** The stream-json events the runner reads from Claude Code. */
type StreamEvent =
  | { type: "system"; subtype: "init" }
  | { type: "assistant"; message: { role: "assistant"; content: Array<{ type: "text"; text: string }> } }
  | { type: "result"; subtype: "success" | "error_during_execution"; is_error: boolean; result: string };

function emit(event: StreamEvent) {
  process.stdout.write(`${JSON.stringify({ ...event, session_id: session })}\n`);
}

async function attach(): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), "fake-claude-")), "screenshot.png");
  writeFileSync(file, PIXEL);
  const { stdout } = await promisify(execFile)("ky-attach", [file, "a fake screenshot"]);

  return stdout.trim();
}

async function turn(prompt: string) {
  if (dying) return;
  record("turn", { prompt });
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `working on: ${prompt}` }] } });

  const delay = /\[delay=(\d+)\]/.exec(prompt);
  await new Promise((resolve) => setTimeout(resolve, delay ? Number(delay[1]) : defaultDelay));
  const attached = prompt.includes("[attach]") ? `\n${await attach()}` : "";

  if (dying) return;
  const failed = prompt.includes("[fail]");
  emit({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed, result: `fake claude did: ${prompt}${attached}` });
}

process.on("SIGINT", () => {
  dying = true;
  record("sigint");
  setTimeout(() => {
    record("exit", { code: 130 });
    process.exit(130);
  }, sigintDelay);
});

record("start", { resume: resume ?? "" });

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
    const prompt = parsed.message.content;
    queue = queue.then(() => turn(prompt));
  })
  .on("close", () => {
    void queue.then(() => {
      if (dying) return;
      record("exit", { code: 0 });
      process.exit(0);
    });
  });
