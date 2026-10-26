/**
 * `node --experimental-strip-types .claude/skills/verify-ky-parity/scripts/real-data.ts <backup.tar.gz> [--base effect-baseline]`
 *
 * Check 4 on real data: the owner's ky, from a `ky backup` (read-only, taken by the owner's say), comes
 * up on this checkout's code as it does at B. On each side (a temporary worktree of `--base`, then this
 * checkout) it starts a fresh local stack, restores the backup into it as `ky restore` does, backs the
 * stack up again and counts what each page shows. Exits 1 when HEAD's round trip loses other rows than
 * B's, or a page shows other counts. The screenshots are for a person to look at.
 *
 * Writes `<side>/report.json` and `<side>/<page>.png` under test-results/parity/real-data/{base,head}/. The
 * screenshots hold the owner's chats: test-results/ is ignored by git, and they stay there.
 * Never pointed at a live ky: the stack is local and signed in with the fake Access.
 */
import { chromium, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { type Archive, readArchive, readTar, restoreArchive, type Send } from "../../../../src/archive.ts";
import { accessCookie, signedIn } from "../../../../src/tests/fake-access.ts";
import { REPO, useStack } from "../../../../test/harness/stack.ts";
import { atBase, run } from "../../../../test/visual/run.ts";

const TIMEOUT = 30_000;

const unpack = (gzipped: Uint8Array) => readArchive(readTar(new Uint8Array(gunzipSync(gzipped))));

function sender(url: string, headers: Record<string, string>): Send {
  return (route, init) => {
    const signed = new Headers(init.headers);

    for (const [name, value] of Object.entries(headers)) signed.set(name, value);

    return fetch(`${url}${route}`, { ...init, headers: signed, redirect: "manual" });
  };
}

/** Each table's row count and the archive's summary, with what differs between two backups. */
function compare(before: Archive, after: Archive): string[] {
  const problems: string[] = [];

  for (const [table, rows] of Object.entries(before.end.rows)) {
    const now = after.end.rows[table];

    if (now !== rows) problems.push(`${table}: ${rows} rows backed up, ${now ?? "none"} after the restore`);
  }

  for (const [field, value] of Object.entries(before.manifest.summary)) {
    const now = after.manifest.summary[field as keyof Archive["manifest"]["summary"]];

    if (now !== value) problems.push(`summary.${field}: ${value} backed up, ${now} after the restore`);
  }

  if (after.end.files !== before.end.files) problems.push(`files: ${before.end.files} backed up, ${after.end.files} after the restore`);

  return problems;
}

/** The pages the owner uses, reached as they reach them. */
const PAGES: ReadonlyArray<{ name: string; open: (page: Page) => Promise<void> }> = [
  { name: "main-chat", open: (page) => page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: /^Main chat/ }).click() },
  { name: "skills", open: (page) => page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "Skills" }).click() },
  { name: "routines", open: (page) => page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "Routines" }).click() },
  { name: "artifacts", open: (page) => page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "Artifacts" }).click() },
  { name: "settings", open: (page) => page.getByRole("complementary", { name: "Activity and settings" }).getByRole("tab", { name: "Settings" }).click() }
];

async function shoot(url: string, out: string): Promise<Record<string, number>> {
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({ baseURL: url, viewport: { width: 1280, height: 860 }, locale: "en-US", timezoneId: "UTC" });

    await context.addCookies([await accessCookie(url)]);
    const page = await context.newPage();

    page.setDefaultTimeout(TIMEOUT);
    await page.goto("/");
    await page.getByRole("button", { name: /^ky: Connected/ }).waitFor();

    for (const shown of PAGES) {
      await shown.open(page);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.screenshot({ path: path.join(out, `${shown.name}.png`) });
    }

    await PAGES[1]?.open(page);
    const skills = await page.getByRole("navigation", { name: "Skills list" }).getByRole("button").count();

    await PAGES[2]?.open(page);
    const routines = await page.getByRole("region", { name: "Routines" }).getByRole("listitem").count();

    return { skills, routines };
  } finally {
    await browser.close();
  }
}

type Report = { shown: Record<string, number>; problems: string[] };

/** Restore `file` into a fresh stack of the checkout this script runs in, back it up again, shoot each page; writes `<out>/report.json`. */
async function side(file: string, out: string): Promise<void> {
  const backup = unpack(readFileSync(file));

  delete process.env.KY_STACK_URL;
  const stack = await useStack(path.join(out, "stack"));

  try {
    const send = sender(stack.url, await signedIn());
    const restored = await restoreArchive(backup, send, false);
    const again = await send("/api/backup", { method: "GET" });

    if (!again.ok) throw new Error(`Backing up the restored stack failed (${again.status}): ${await again.text()}`);
    const problems = compare(backup, unpack(new Uint8Array(await again.arrayBuffer())));
    const shown = await shoot(stack.url, out);

    writeFileSync(path.join(out, "report.json"), `${JSON.stringify({ backup: path.basename(file), commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(), summary: backup.manifest.summary, restored: restored.summary, shown, problems }, null, 2)}\n`);
  } finally {
    await stack.stop();
  }
}

const SCRIPT = path.relative(REPO, import.meta.filename);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const file = args[0] === undefined || args[0].startsWith("--") ? undefined : path.resolve(args[0]);

  if (file === undefined) throw new Error("Usage: real-data.ts <backup.tar.gz> [--base effect-baseline]");
  const at = flag("--side");

  if (at !== undefined) return side(file, path.resolve(at));

  const base = flag("--base") ?? "effect-baseline";
  const out = (label: string) => path.join(REPO, "test-results/parity/real-data", label);
  const read = (label: string): Report => JSON.parse(readFileSync(path.join(out(label), "report.json"), "utf8"));

  atBase(base, [path.dirname(SCRIPT), "test/visual"], (tree) => run(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT, file, "--side", out("base")], tree));
  await side(file, out("head"));

  const [before, after] = [read("base"), read("head")];
  const differ = [
    ...(JSON.stringify(before.problems) === JSON.stringify(after.problems) ? [] : [`round trip: ${base} lost ${JSON.stringify(before.problems)}, HEAD lost ${JSON.stringify(after.problems)}`]),
    ...Object.keys(before.shown).filter((key) => before.shown[key] !== after.shown[key]).map((key) => `${key} shown: ${before.shown[key]} at ${base}, ${after.shown[key]} at HEAD`)
  ];

  console.log(JSON.stringify({ shown: after.shown, lostOnBoth: after.problems }, null, 2));
  console.log(differ.length === 0 ? `real data: HEAD brings the backup up as ${base} does (${out("head")})` : `real data: ${differ.length} differ from ${base}:\n  ${differ.join("\n  ")}`);
  process.exitCode = differ.length === 0 ? 0 : 1;
}

await main();
