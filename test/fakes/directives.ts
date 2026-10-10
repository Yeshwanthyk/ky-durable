/**
 * What the fake claude and the fake codex both do for a directive in a
 * prompt, each then speaking its own CLI's JSON.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** A 1x1 transparent PNG. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** The tools a `[tools=Bash:pnpm test,Edit:src/x.ts]` directive asks for: each name, with its one argument. */
export function toolsIn(prompt: string): { name: string; value: string }[] {
  const listed = /\[tools=([^\]]+)\]/.exec(prompt)?.[1] ?? "";

  return listed
    .split(",")
    .filter((each) => each.includes(":"))
    .map((each) => ({ name: each.slice(0, each.indexOf(":")), value: each.slice(each.indexOf(":") + 1) }));
}

/** `[delay=MS]`: wait MS milliseconds, else `fallback`. */
export function pause(prompt: string, fallback: number): Promise<void> {
  const delay = /\[delay=(\d+)\]/.exec(prompt)?.[1];

  return new Promise((resolve) => setTimeout(resolve, delay === undefined ? fallback : Number(delay)));
}

/** `[attach]`: share a 1x1 PNG through `ky attach`, as a screenshot would be, run with `env`; what it printed. */
export async function attach(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), "fake-agent-")), "screenshot.png");
  writeFileSync(file, PIXEL);
  const { stdout } = await promisify(execFile)("ky", ["attach", file, "a fake screenshot"], { env });

  return stdout.trim();
}
