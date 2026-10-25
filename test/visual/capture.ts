/**
 * `node --experimental-strip-types test/visual/capture.ts <label> [--out <dir>]`: a screenshot of each
 * page of ky's web app, from the checkout this file sits in, for test/visual/diff.ts to compare.
 *
 * It starts that checkout's local stack on a free port (test/harness/stack.ts), always a fresh one with
 * empty state, even when KY_STACK_URL is set: a stack that has already been used shows what it was used
 * for. It seeds a skill, two routines, a published site and two chats through the composer's `tool`
 * prompts, as the web suite does, then writes `<dir>/<page>.png` (default test-results/visual/<label>/).
 *
 * Two runs of one commit must match pixel for pixel, so what changes between runs is held still: the
 * browser's zone, locale, size and motion are fixed, animations and the caret are off, every name is
 * fixed rather than random, ids the server makes stay in a chat no page shows, and what shows the time
 * is masked (MASK).
 */
import { chromium, type Locator, type Page } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { accessCookie } from "../../src/tests/fake-access.ts";
import { REPO, useStack } from "../harness/stack.ts";

type Shot = { readonly name: string; readonly take: (page: Page) => Promise<void> };

const TIMEOUT = 20_000;

const panel = (page: Page) => page.getByRole("complementary", { name: "Activity and settings" });

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Chats" });

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });

/**
 * What shows the clock or a time relative to it, and so differs between runs: a chat's age in the
 * sidebar, Today's date, its now line and its times, a routine's "Next run in" and a skill's "changed
 * now". The schedule beside "Next run in" and the use count beside "changed" are masked with them; a
 * paused routine's line shows the same schedule unmasked.
 */
const MASK = (page: Page): Locator[] => [
  page.locator(".chat-time"),
  page.locator(".today-date"),
  page.locator(".today-now"),
  page.locator(".today-time"),
  page.locator(".rt-meta", { hasText: "Next run in" }),
  page.locator(".skills-reader-meta")
];

async function send(page: Page, text: string, answer: string | RegExp): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(text);
  await composer.press("Enter");
  await chat(page).getByText(answer).first().waitFor({ timeout: TIMEOUT });
}

const tool = (name: string, args: Record<string, string>) => `tool ${name} ${JSON.stringify(args)}`;

/** The state every page is drawn over, made where the e2e suite makes it: the fake model's tool calls. */
async function seed(page: Page): Promise<void> {
  const chats = sidebar(page);

  // The tool calls answer with ids the server made, so they go in a side chat no page shows.
  await chats.getByRole("button", { name: "New side chat" }).click();
  await page.getByRole("heading", { name: "A side chat" }).waitFor({ timeout: TIMEOUT });
  await send(page, "Set up the screenshots", "echo: Set up the screenshots");
  await send(page, tool("skill_manage", { action: "create", name: "groceries", description: "Ordering groceries", body: "## Steps\n1. Open the list.\n2. Order oat milk." }), /tool said: Created groceries/);
  await send(page, tool("automation", { action: "create", title: "Inbox digest", prompt: "sum up the inbox", cron: "0 9 * * 1-5", createdBy: "user" }), /Created automation \w+, "Inbox digest"/);
  await send(page, tool("automation", { action: "create", title: "Weekly review", prompt: "review the week", cron: "0 16 * * 5", createdBy: "user" }), /Created automation \w+, "Weekly review"/);
  const weekly = await chat(page).getByText(/Created automation \w+, "Weekly review"/).first().textContent();
  await send(page, tool("automation", { action: "pause", id: /Created automation (\w+),/.exec(weekly ?? "")?.[1] ?? "" }), /tool said:.*[Pp]aused/);
  const html = '<!doctype html><body style="margin:0;background:#e8eef7;font:64px sans-serif">Quarterly report</body>';
  await send(page, tool("site", { action: "publish", title: "Quarterly report", html }), /\(id [0-9a-f]{32},/);

  // A side chat a page shows: what the user and ky said, nothing made by the server.
  await chats.getByRole("button", { name: "New side chat" }).click();
  await page.getByRole("heading", { name: "A side chat" }).waitFor({ timeout: TIMEOUT });
  await send(page, "Plan a trip to Lisbon", "echo: Plan a trip to Lisbon");
  await chats.getByRole("button", { name: /^Named: Plan a trip to Lisbon/ }).waitFor({ timeout: TIMEOUT });

  await chats.getByRole("button", { name: "Main chat" }).click();
  await send(page, "Plan my week", "echo: Plan my week");
}

/** Each page, reached as the user reaches it. The name is the PNG's. */
const SHOTS: readonly Shot[] = [
  {
    name: "main-chat",
    take: async (page) => {
      await sidebar(page).getByRole("button", { name: /^Main chat/ }).click();
      await chat(page).getByText("echo: Plan my week").waitFor({ timeout: TIMEOUT });
    }
  },
  {
    name: "side-chat",
    take: async (page) => {
      await sidebar(page).getByRole("button", { name: /^Named: Plan a trip to Lisbon/ }).click();
      await chat(page).getByText("echo: Plan a trip to Lisbon").waitFor({ timeout: TIMEOUT });
    }
  },
  {
    name: "skills",
    take: async (page) => {
      await sidebar(page).getByRole("button", { name: "Skills" }).click();
      const skills = page.getByRole("region", { name: "Skills" });
      await skills.getByRole("navigation", { name: "Skills list" }).getByRole("button", { name: /^groceries/ }).click();
      await skills.getByRole("article", { name: "groceries" }).getByText("Order oat milk.").waitFor({ timeout: TIMEOUT });
    }
  },
  {
    name: "artifacts",
    take: async (page) => {
      await sidebar(page).getByRole("button", { name: "Artifacts" }).click();
      await page.getByRole("region", { name: "Artifacts" }).getByRole("link", { name: "Open Quarterly report" }).waitFor({ timeout: TIMEOUT });
    }
  },
  {
    name: "routines",
    take: async (page) => {
      await sidebar(page).getByRole("button", { name: "Routines" }).click();
      const routines = page.getByRole("region", { name: "Routines" });
      await routines.getByRole("listitem", { name: "Weekly review" }).getByText("Paused").first().waitFor({ timeout: TIMEOUT });
      await routines.getByRole("listitem", { name: "Inbox digest" }).waitFor({ timeout: TIMEOUT });
    }
  },
  {
    name: "routine-open",
    take: async (page) => {
      await sidebar(page).getByRole("button", { name: "Routines" }).click();
      const row = page.getByRole("region", { name: "Routines" }).getByRole("listitem", { name: "Inbox digest" });
      await row.getByRole("button", { name: /Inbox digest/ }).first().click();
      await row.getByText("No runs yet. Run now tries it.").waitFor({ timeout: TIMEOUT });
    }
  },
  {
    name: "activity",
    take: async (page) => {
      await sidebar(page).getByRole("button", { name: /^Main chat/ }).click();
      await panel(page).getByRole("tab", { name: "Activity" }).click();
    }
  },
  {
    name: "settings",
    take: async (page) => {
      await sidebar(page).getByRole("button", { name: /^Main chat/ }).click();
      await panel(page).getByRole("tab", { name: "Settings" }).click();
    }
  }
];

/** Let the page settle: nothing focused or hovered, fonts in, no request in flight, and two frames drawn since. */
async function settle(page: Page): Promise<void> {
  // A focused composer draws a caret that blinks, and the row just clicked shows its hover buttons.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(1279, 859);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(500);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const label = args[0];

  if (label === undefined || label.startsWith("--")) throw new Error("Usage: capture.ts <label> [--out <dir>]");
  const at = args.indexOf("--out");
  const out = at === -1 ? path.join(REPO, "test-results/visual", label) : path.resolve(args[at + 1] ?? "");

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  delete process.env.KY_STACK_URL;
  // The stack's log, and what the page showed if a step failed, sit beside the shots: a base worktree is gone by the time anyone reads them.
  const logs = path.join(out, "stack");
  const stack = await useStack(logs);
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({
      baseURL: stack.url,
      viewport: { width: 1280, height: 860 },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      colorScheme: "light",
      reducedMotion: "reduce"
    });

    await context.addCookies([await accessCookie(stack.url)]);
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    try {
      await page.goto("/");
      await page.getByRole("button", { name: /^ky: Connected/ }).waitFor();
      await seed(page);

      for (const shot of SHOTS) {
        await shot.take(page);
        await settle(page);
        await page.screenshot({ path: path.join(out, `${shot.name}.png`), animations: "disabled", caret: "hide", mask: MASK(page), maskColor: "#ff00ff" });
        console.log(`${label}: ${shot.name}.png`);
      }
    } catch (error) {
      await page.screenshot({ path: path.join(logs, "failed.png") });
      throw error;
    }
  } finally {
    await browser.close();
    await stack.stop();
  }
}

await main();
