/**
 * What a task shares with the user, from inside the task: `ky attach <file> [caption]` shows an
 * image or video, and `ky diff [base]` the current repository's changes, where the user can
 * comment on lines. Each goes on the task and in its report, sent with the task's own token,
 * KY_TASK_TOKEN, which the runner gives each task (C1).
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { DIFF_TYPE, MAX_DIFF_BYTES } from "../../src/files/contract.ts";
import { captureDiff, type Git } from "./diff.ts";

const git: Git = (args) => {
  const run = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (run.error) throw run.error;

  return { status: run.status ?? 1, stdout: run.stdout };
};

type Task = { url: string; token: string; task: string };

/** The task this runs in, from the environment the runner gives it. */
function taskOf(env: NodeJS.ProcessEnv): Task {
  const { KY_URL, KY_TASK_TOKEN, KY_TASK } = env;

  if (!KY_URL || !KY_TASK_TOKEN || !KY_TASK) throw new Error("run this inside a ky task");

  return { url: KY_URL.replace(/\/$/, ""), token: KY_TASK_TOKEN, task: KY_TASK };
}

/** Put a file on the task: `name` and `caption` as the user sees them. */
async function upload(task: Task, body: Uint8Array<ArrayBuffer>, type: string, name: string, caption?: string): Promise<void> {
  const response = await fetch(`${task.url}/api/files?task=${encodeURIComponent(task.task)}`, {
    method: "PUT",
    headers: {
      "Content-Type": type,
      Authorization: `Bearer ${task.token}`,
      "X-Ky-Name": encodeURIComponent(name),
      ...(caption && { "X-Ky-Caption": encodeURIComponent(caption) })
    },
    body
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).trim()}`);
}

const MEDIA = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".webm", "video/webm"],
  [".mp4", "video/mp4"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"]
]);

/** `ky attach <file> [caption]`: what it printed. */
export async function attach([file, caption]: string[], env: NodeJS.ProcessEnv): Promise<string> {
  if (!file) throw new Error("usage: ky attach <file> [caption]");
  const task = taskOf(env);
  const type = MEDIA.get(extname(file).toLowerCase());

  if (!type) throw new Error("png, jpeg, webp, gif, webm, mp4, m4a, mp3, ogg, opus or wav only");
  await upload(task, new Uint8Array(await readFile(file)), type, basename(file), caption);

  return `Attached: ${basename(file)}`;
}

/** `ky diff [base]`, run inside a repository: what it printed. */
export async function diff([base]: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const task = taskOf(env);
  const root = git(["rev-parse", "--show-toplevel"]);

  if (root.status !== 0) throw new Error("run this inside a git repository");
  const patch = captureDiff(git, base);

  if (patch === "") return "No changes to share.";

  const body = new TextEncoder().encode(patch);

  if (body.byteLength > MAX_DIFF_BYTES) throw new Error(`the diff is over ${MAX_DIFF_BYTES / 1024 / 1024} MB; pass a later base`);
  const repo = basename(root.stdout.trim());
  const branch = git(["branch", "--show-current"]).stdout.trim();

  await upload(task, body, DIFF_TYPE, `${repo}.diff`, branch ? `${repo} · ${branch}` : repo);

  return `Shared the changes in ${repo}.`;
}
