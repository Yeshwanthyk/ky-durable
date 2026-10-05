/**
 * ky-diff [base]: share the current repository's changes with the user, on
 * this task and in its report, where they can comment on lines. The runner
 * puts it on each task's PATH; run it from inside the repository, again
 * whenever the changes do.
 */
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { DIFF_TYPE, MAX_DIFF_BYTES } from "../src/files.ts";
import { captureDiff, type Git } from "./diff.ts";

const git: Git = (args) => {
  const run = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (run.error) throw run.error;

  return { status: run.status ?? 1, stdout: run.stdout };
};

type Task = { url: string; token: string; task: string };

/** The task this runs in, from the environment the runner gives it. */
function taskOf(): Task {
  const { KY_URL, KY_TOKEN, KY_TASK } = process.env;

  if (!KY_URL || !KY_TOKEN || !KY_TASK) throw new Error("run this inside a ky task");

  return { url: KY_URL.replace(/\/$/, ""), token: KY_TOKEN, task: KY_TASK };
}

/** Put the patch on the task, named for the repository and captioned with its branch. */
async function upload(task: Task, body: Uint8Array<ArrayBuffer>, repo: string): Promise<void> {
  const branch = git(["branch", "--show-current"]).stdout.trim();

  const response = await fetch(`${task.url}/api/files?task=${encodeURIComponent(task.task)}`, {
    method: "PUT",
    headers: {
      "Content-Type": DIFF_TYPE,
      Authorization: `Bearer ${task.token}`,
      "X-Ky-Name": encodeURIComponent(`${repo}.diff`),
      "X-Ky-Caption": encodeURIComponent(branch ? `${repo} · ${branch}` : repo)
    },
    body
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).trim()}`);
}

async function main() {
  const task = taskOf();
  const root = git(["rev-parse", "--show-toplevel"]);

  if (root.status !== 0) throw new Error("run this inside a git repository");
  const patch = captureDiff(git, process.argv[2]);

  if (patch === "") {
    console.log("No changes to share.");

    return;
  }

  const body = new TextEncoder().encode(patch);

  if (body.byteLength > MAX_DIFF_BYTES) throw new Error(`the diff is over ${MAX_DIFF_BYTES / 1024 / 1024} MB; pass a later base`);
  const repo = basename(root.stdout.trim());
  await upload(task, body, repo);
  console.log(`Shared the changes in ${repo}.`);
}

main().catch((error) => {
  console.error(`ky-diff: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
