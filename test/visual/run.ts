/**
 * `node --experimental-strip-types test/visual/run.ts [--base effect-baseline] [--threshold 0.001]`: the
 * Visual step. Captures every page at `--base` and in this checkout, compares them with diff.ts, and
 * exits 1 when any page differs beyond the threshold; test-results/visual/report.json names them and
 * test-results/visual/diff/ shows where.
 *
 * The base is captured from a temporary `git worktree add` of it, removed afterwards. That worktree gets
 * a node_modules (the global post-checkout hook clones the main checkout's; failing that, an APFS clone
 * of this checkout's), always settled to the base's own lockfile with an offline `pnpm install`, since
 * the main checkout can be on a branch with other dependencies. It also gets this checkout's test/visual/, so both sides are captured by the same script, each
 * against its own stack, one after the other.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO } from "../harness/stack.ts";
import { diff, print } from "./diff.ts";

const OUT = path.join(REPO, "test-results/visual");

/** Run a command to completion, its output passed through; throws when it fails. */
function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });

  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd} (${result.status ?? result.signal})`);
}

const capture = (checkout: string, label: string) =>
  run(process.execPath, ["--experimental-strip-types", "--no-warnings", "test/visual/capture.ts", label, "--out", path.join(OUT, label)], checkout);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback);
  const base = flag("--base", "effect-baseline");
  const threshold = Number(flag("--threshold", "0.001"));
  const tree = path.join(mkdtempSync(path.join(tmpdir(), "ky-visual-")), "base");

  run("git", ["worktree", "add", "--detach", tree, base], REPO);

  try {
    if (!existsSync(path.join(tree, "node_modules"))) run("cp", ["-c", "-R", path.join(REPO, "node_modules"), path.join(tree, "node_modules")], REPO);
    run("pnpm", ["install", "--offline", "--frozen-lockfile", "--silent"], tree);

    cpSync(path.join(REPO, "test/visual"), path.join(tree, "test/visual"), { recursive: true });
    capture(tree, "base");
  } finally {
    run("git", ["worktree", "remove", "--force", tree], REPO);
    rmSync(path.dirname(tree), { recursive: true, force: true });
  }

  capture(REPO, "head");
  process.exitCode = print(await diff("base", "head", threshold), `${base} vs HEAD`, threshold);
}

await main();
