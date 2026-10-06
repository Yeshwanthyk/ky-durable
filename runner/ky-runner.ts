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
 *
 * Each task finds two commands on its PATH: ky-attach shares an image or
 * video, and ky-diff shares a repository's changes as a reviewable diff.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { REPLACED } from "../src/runner-protocol.ts";
import { HandledSeqs } from "./handled.ts";
import { Runner, type ClaudeProcess, type ClaudeEvents, type Link } from "./runner.ts";

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

/** Where the runner keeps what must outlive it: the seqs of the commands it has run. */
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

/** Added to Claude Code's system prompt in every task. */
const TASK_PROMPT = `You are running a task for ky, the user's agent; the user reads the result in ky, often on a phone.

To show the user a screenshot, a recording or a chart, attach it: ky-attach <file> [caption] (png, jpeg, webp, gif, webm or mp4, at most 25 MB). It appears on this task and in its report. Attach every image or video you make for the user, and mention it in your answer.
- For web pages use Playwright. The first time, install it in ${CAPTURE}: mkdir -p ${CAPTURE} && cd ${CAPTURE} && echo '{"private":true}' > package.json && npm install playwright && npx playwright install chromium. Run capture scripts from there.
- Screenshot at a 390x844 viewport unless asked otherwise. Record video with the browser context option recordVideo: { dir, size }; the webm is saved when the context closes.
- Save captures under ${join(WORKDIR, ".captures")}, never inside a repository.

When you change code in a git repository, run ky-diff from inside it before you answer, and again after any later change: the user sees the changes on this task and can comment on lines. It shares everything since the branch left the default branch; pass a commit (ky-diff <base>) to start elsewhere.${
  CHROME
    ? "\n\nFor anything that needs the user's logins, use the user's own Chrome through the Claude in Chrome tools; Playwright starts logged out. Never read, copy or report passwords, cookies or tokens."
    : ""
}`;

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

/** Start `claude -p` with stream-json on both ends, in the work dir. */
function spawnClaude(task: string, session: string | null, events: ClaudeEvents): ClaudeProcess {
  mkdirSync(WORKDIR, { recursive: true });

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    // Echo each message as Claude Code takes it in; the runner counts them to know what a result answers.
    "--replay-user-messages",
    "--permission-mode", PERMISSION_MODE,
    "--append-system-prompt", TASK_PROMPT,
    ...(CHROME ? ["--chrome"] : []),
    ...(session ? ["--resume", session] : [])
  ];

  const child: ChildProcessWithoutNullStreams = spawn(CLAUDE, args, {
    cwd: WORKDIR,
    env: {
      ...process.env,
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
    write: (line) => {
      child.stdin.write(line);
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
  spawnClaude,
  (line) => log(line),
  new HandledSeqs(join(STATE_DIR, `handled-${MACHINE}.json`), `${URL_BASE} ${MACHINE}`)
);

let socket: WebSocket | undefined;

let backoff = 1_000;

function connect() {
  const url = `${URL_BASE.replace(/^http/, "ws")}/agents/pi-agent/me?runner=${MACHINE}`;
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

    if (code === REPLACED) {
      log(`another runner connected as ${MACHINE}; exiting. Give each machine its own KY_MACHINE.`);
      runner.shutdown();
      process.exit(1);
    }

    // The reason tells "update ky-runner" (1008) apart from a flaky network.
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

connect();
