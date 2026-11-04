#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * strobe.json's `build`: the local stack built as production builds it (test/harness/stack.ts buildStack), then
 * started once on a fresh state that test/stack/seed.ts fills with a week of use, plus a side chat of
 * LONG_TURNS long answers (perf/content.ts). perf/serve.ts serves a copy of that state for every bench block.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { accessCookie } from "../src/tests/fake-access.ts";
import { buildStack, REPO, startStack } from "../test/harness/stack.ts";
import { answer, finished } from "./content.ts";
import { BUILT, LONG_CHAT, LONG_TURNS, OUT, STATE } from "./stack.ts";

/** How long seeding may take before the build gives up on it. */
const SEED_TIMEOUT = 10 * 60_000;

const log = (what: string) => console.log(`perf build: ${what}`);

rmSync(OUT, { recursive: true, force: true });

// The seed pairs a fresh Mac each time; one left from an earlier build is paired with that build's stack.
rmSync(path.join(REPO, "test-results/seed-stack/webmac"), { recursive: true, force: true });

mkdirSync(STATE, { recursive: true });

log("building the stack");

buildStack(BUILT, path.join(OUT, "build.log"));

process.env.KY_STACK_STATE = STATE;

const stack = await startStack(path.join(OUT, "stack.log"), { built: BUILT });

try {
  log(`seeding ${stack.url}`);
  await seed(stack.url);
  log(`filling "${LONG_CHAT}" with ${LONG_TURNS} turns`);
  await longChat(stack.url);
} finally {
  await stack.stop();
}

log(`done: ${BUILT}, state in ${STATE}`);

/** test/stack/seed.ts until it says it seeded; then stop it, and the Mac it paired with it. */
function seed(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(REPO, "test/stack/seed.ts")], {
      cwd: REPO,
      env: { ...process.env, KY_STACK_URL: url },
      stdio: ["ignore", "pipe", "inherit"]
    });

    // The line can arrive split across chunks: match what has been said so far, not the last chunk.
    let said = "";

    const deadline = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`seeding ${url} took longer than ${SEED_TIMEOUT / 60_000} minutes`));
    }, SEED_TIMEOUT);

    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      said += chunk.toString();

      if (/^Seeded /m.test(said)) child.kill("SIGTERM");
    });

    child.once("exit", (code, signal) => {
      clearTimeout(deadline);

      if (code === 0 || signal === "SIGTERM") resolve();
      else reject(new Error(`seed exited ${code ?? signal}`));
    });
  });
}

/** A side chat named LONG_CHAT with LONG_TURNS long answers, sent as the owner sends them. */
async function longChat(url: string): Promise<void> {
  const browser = await chromium.launch({ channel: "chrome" });

  try {
    const context = await browser.newContext({ baseURL: url, viewport: { width: 1440, height: 900 } });
    await context.addCookies([await accessCookie(url)]);
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: /^ky: Connected/ }).waitFor({ timeout: 30_000 });
    await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "New side chat" }).click();
    await page.getByRole("heading", { name: "A side chat" }).waitFor({ timeout: 30_000 });
    const composer = page.getByRole("textbox", { name: "Message" });
    const chat = page.getByRole("region", { name: "Chat" });

    for (let turn = 1; turn <= LONG_TURNS; turn++) {
      await composer.fill(turn === 1 ? `reply: ${LONG_CHAT}` : `reply: ${answer(turn)}`);
      await composer.press("Enter");
      await chat
        .getByText(turn === 1 ? LONG_CHAT : finished(turn))
        .last()
        .waitFor({ timeout: 60_000 })
        .catch(async (error: Error) => {
          await page.screenshot({ path: path.join(OUT, "long-chat-failed.png") });
          throw error;
        });
      await page.waitForTimeout(300);
    }
  } finally {
    await browser.close();
  }
}
