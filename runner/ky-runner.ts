#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ky's machine runner. Run it on a computer you want ky to use: it dials
 * into your agent over a WebSocket and runs each task as a Claude Code
 * session on this machine, with your own `claude` login, shell, files and
 * browser. Nothing listens on a port.
 *
 *   KY_URL=https://ky.<you>.workers.dev KY_TOKEN=... node runner/ky-runner.ts
 *
 * KY_TOKEN_FILE   read KY_TOKEN from this file instead
 * KY_MACHINE      name shown in ky (default: this host's name)
 * KY_WORKDIR      where tasks run (default: ~/ky-work)
 * KY_PERMISSION_MODE  Claude Code permission mode (default: bypassPermissions)
 * KY_CLAUDE       the claude executable (default: claude)
 * KY_CHROME       1: tasks drive the user's Chrome, with its logins (Claude in Chrome)
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Command =
  | { type: "run"; seq: number; task: string; prompt: string; session: string | null }
  | { type: "stop"; seq: number; task: string };

type Report =
  | { type: "hello"; active: string[] }
  | { type: "ack"; seq: number }
  | { type: "session"; task: string; session: string }
  | { type: "progress"; task: string; text: string }
  | { type: "result"; task: string; ok: boolean; text: string; session: string | null };

type Run = {
  child: ChildProcessWithoutNullStreams;
  session: string | null;
  /** Messages written that have no result yet. */
  pending: number;
  stopped: boolean;
  last: string;
};

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

const CHROME = process.env.KY_CHROME === "1";

const PROGRESS_EVERY_MS = 4_000;

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

/** Added to Claude Code's system prompt in every task. */
const TASK_PROMPT = `You are running a task for ky, the user's agent; the user reads the result in ky, often on a phone.

To show the user a screenshot, a recording or a chart, attach it: ky-attach <file> [caption] (png, jpeg, webp, gif, webm or mp4, at most 25 MB). It appears on this task and in its report. Attach every image or video you make for the user, and mention it in your answer.
- For web pages use Playwright. The first time, install it in ${CAPTURE}: mkdir -p ${CAPTURE} && cd ${CAPTURE} && echo '{"private":true}' > package.json && npm install playwright && npx playwright install chromium. Run capture scripts from there.
- Screenshot at a 390x844 viewport unless asked otherwise. Record video with the browser context option recordVideo: { dir, size }; the webm is saved when the context closes.
- Save captures under ${join(WORKDIR, ".captures")}, never inside a repository.${
  CHROME
    ? "\n\nFor anything that needs the user's logins, use the user's own Chrome through the Claude in Chrome tools; Playwright starts logged out. Never read, copy or report passwords, cookies or tokens."
    : ""
}`;

function installAttach() {
  mkdirSync(BIN, { recursive: true });
  const file = join(BIN, "ky-attach");
  writeFileSync(file, ATTACH);
  chmodSync(file, 0o755);
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

const runs = new Map<string, Run>();

const handled = new Set<number>();

let socket: WebSocket | undefined;

/** Reports made while disconnected, sent on the next connect. */
const outbox: Report[] = [];

function report(message: Report) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  else if (message.type !== "progress" && message.type !== "ack") outbox.push(message);
}

function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

function start(task: string, prompt: string, session: string | null) {
  mkdirSync(WORKDIR, { recursive: true });

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", PERMISSION_MODE,
    "--append-system-prompt", TASK_PROMPT,
    ...(CHROME ? ["--chrome"] : []),
    ...(session ? ["--resume", session] : [])
  ];

  log(`${task}: start${session ? ` (resume ${session.slice(0, 8)})` : ""}`);

  const child = spawn(CLAUDE, args, {
    cwd: WORKDIR,
    env: {
      ...process.env,
      KY_TOKEN: TOKEN,
      KY_TASK: task,
      PATH: `${BIN}:${process.env.PATH ?? ""}`
    }
  });

  const run: Run = { child, session, pending: 1, stopped: false, last: "" };
  runs.set(task, run);
  let lastProgress = 0;

  createInterface({ input: child.stdout }).on("line", (line) => {
    let event: any;

    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.session_id && event.session_id !== run.session) {
      run.session = event.session_id;
      report({ type: "session", task, session: event.session_id });
    }

    if (event.type === "assistant") {
      const text = (event.message?.content ?? [])
        .flatMap((part: any) =>
          part.type === "text" ? [part.text] : part.type === "tool_use" ? [`Using ${part.name}`] : []
        )
        .join(" ")
        .trim();

      if (text && Date.now() - lastProgress > PROGRESS_EVERY_MS) {
        lastProgress = Date.now();
        report({ type: "progress", task, text });
      }
    }

    if (event.type === "result") {
      run.pending = Math.max(0, run.pending - 1);
      run.last = String(event.result ?? "");

      if (run.pending > 0) {
        report({ type: "progress", task, text: run.last });

        return;
      }

      // Nothing more to answer: end the session so the result is final.
      child.stdin.end();
      report({
        type: "result",
        task,
        ok: !event.is_error && !run.stopped,
        text: run.stopped ? "Stopped." : run.last || (event.is_error ? "Failed." : "Done."),
        session: run.session
      });
      runs.delete(task);
    }
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.on("close", (code) => {
    log(`${task}: exit ${code}`);

    if (runs.get(task) !== run) return;
    runs.delete(task);
    report({
      type: "result",
      task,
      ok: false,
      text: run.stopped ? "Stopped." : `claude exited with ${code}. ${stderr.trim()}`,
      session: run.session
    });
  });
  child.on("error", (error) => {
    stderr += String(error);
  });
  child.stdin.write(userLine(prompt));
}

function onCommand(command: Command) {
  report({ type: "ack", seq: command.seq });

  if (handled.has(command.seq)) return;
  handled.add(command.seq);
  const run = runs.get(command.task);

  if (command.type === "stop") {
    if (run) {
      run.stopped = true;
      run.child.kill("SIGINT");
      setTimeout(() => run.child.kill("SIGKILL"), 5_000).unref();
    }

    return;
  }

  if (run) {
    // Steer: Claude Code takes it as the next user message in this session.
    run.pending += 1;
    run.child.stdin.write(userLine(command.prompt));
    log(`${command.task}: steer`);

    return;
  }

  start(command.task, command.prompt, command.session);
}

let backoff = 1_000;

function connect() {
  const url = `${URL_BASE.replace(/^http/, "ws")}/agents/pi-agent/me?runner=${MACHINE}`;
  // Node's WebSocket (undici) takes headers as a non-standard option.
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } } as any);
  socket = ws;
  ws.addEventListener("open", () => {
    backoff = 1_000;
    log(`connected as ${MACHINE}, working in ${WORKDIR}`);
    ws.send(JSON.stringify({ type: "hello", active: [...runs.keys()] } satisfies Report));

    for (const message of outbox.splice(0)) ws.send(JSON.stringify(message));
  });
  ws.addEventListener("message", (event) => {
    let message: Partial<Command>;

    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    // The socket also carries the Agents SDK's own frames; skip those.
    if ((message.type === "run" || message.type === "stop") && typeof message.seq === "number") {
      onCommand(message as Command);
    }
  });
  ws.addEventListener("close", (event) => {
    if (socket === ws) socket = undefined;
    log(`disconnected (${event.code}), retrying in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  });
  ws.addEventListener("error", () => {
    // close follows.
  });
}

// Keep the socket alive through idle proxies.
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "hello", active: [...runs.keys()] }));
}, 30_000);

process.on("SIGINT", () => {
  for (const run of runs.values()) run.child.kill("SIGINT");
  process.exit(0);
});

installAttach();

connect();
