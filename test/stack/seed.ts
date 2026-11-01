/**
 * `pnpm seed`: fills a running local stack (`pnpm stack`, or KY_STACK_URL) with what a week of use leaves,
 * so every page has something to show: chats with cards, tables and charts, side chats, skills and a kit, two
 * published pages, routines that ran and one paused, a memory note, two specialists with avatars, Executor
 * connected, the Mac paired with tasks done, failed and still running, helpers done today and last night's dream.
 *
 * The fake model plays each prompt as src/tests/seed-script.ts scripts it, through ky's real tools. A real
 * runner pairs as `webmac` and stays up, so the live task keeps running; Ctrl-C stops it.
 */
import { chromium, type Page } from "@playwright/test";
import path from "node:path";
import { accessCookie } from "../../src/tests/fake-access.ts";
import { machine, pairingCode, type Runner } from "../harness/runner.ts";
import { REPO } from "../harness/stack.ts";

const URL = process.env.KY_STACK_URL ?? "http://127.0.0.1:8790";

const TIMEOUT = 30_000;

const panel = (page: Page) => page.getByRole("complementary", { name: "Activity and settings" });

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Chats" });

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });

const step = (what: string) => console.log(`· ${what}`);

/** Send `text` and wait for ky's answer to end on `done`. */
async function send(page: Page, text: string, done: string | RegExp): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(text);
  await composer.press("Enter");
  await chat(page).getByText(done).first().waitFor({ timeout: TIMEOUT }).catch(async (error: Error) => {
    await page.screenshot({ path: path.join(REPO, "test-results/seed-stack/failed.png") });
    console.error(`Stuck on "${text}"; the page is in test-results/seed-stack/failed.png. The chat shows:\n${await chat(page).innerText()}`);
    throw error;
  });
  // The stream settles before the next turn starts.
  await page.waitForTimeout(400);
}

async function sideChat(page: Page): Promise<void> {
  await sidebar(page).getByRole("button", { name: "New side chat" }).click();
  await page.getByRole("heading", { name: "A side chat" }).waitFor({ timeout: TIMEOUT });
}

async function settings(page: Page, row: string): Promise<void> {
  await panel(page).getByRole("tab", { name: "Settings" }).click();
  const back = panel(page).locator(".page-back");

  while (await back.isVisible()) await back.click();
  await panel(page).getByRole("button", { name: new RegExp(`^${row}`) }).first().click();
}

async function executor(page: Page): Promise<void> {
  await settings(page, "Tools");
  const form = panel(page).getByRole("form", { name: "Connect Executor" });
  const connected = panel(page).getByText("https://executor.test/mcp", { exact: true });
  await form.or(connected).first().waitFor({ timeout: TIMEOUT });

  if (await form.isVisible()) {
    await form.getByLabel("Executor URL").fill("https://executor.test/mcp");
    await form.getByLabel("Executor token").fill("ky-stack-executor");
    await form.getByRole("button", { name: "Test and connect" }).click();
  }

  await connected.waitFor({ timeout: TIMEOUT });
}

async function specialist(page: Page, id: string, description: string, brief: string): Promise<void> {
  await panel(page).getByRole("tab", { name: "Soul" }).click();
  await panel(page).getByRole("button", { name: "+ Specialist" }).waitFor({ timeout: TIMEOUT });

  if (await panel(page).getByRole("button", { name: new RegExp(`^@${id}`) }).count()) return;
  await panel(page).getByRole("button", { name: "+ Specialist" }).click();
  const form = page.getByRole("dialog", { name: "New specialist" });
  await form.getByRole("textbox", { name: "Id" }).fill(id);
  await form.getByRole("textbox", { name: "Description" }).fill(description);
  await form.getByRole("textbox", { name: "Brief" }).fill(brief);
  await form.getByRole("button", { name: "Save" }).click();
  await form.waitFor({ state: "hidden", timeout: TIMEOUT });
}

async function routines(page: Page) {
  await panel(page).getByRole("tab", { name: "Activity" }).click();
  await panel(page).getByRole("button", { name: /routines?$/i }).click();

  return panel(page).getByRole("region", { name: "Routines" });
}

// Last night's dream, so Activity has a night to show.
async function dream(page: Page): Promise<void> {
  step("last night's dream");
  const dreamt = await page.request.post("/test/dream-night?tag=fri");

  if (!dreamt.ok()) throw new Error(`The dream didn't seed (${dreamt.status()}): ${(await dreamt.text()).slice(0, 300)}`);
}

// Fails fast without a stack, then pairs the Mac the machine tasks run on.
async function pairMac(): Promise<Runner> {
  const ready = await fetch(`${URL}/manifest.webmanifest`).catch(() => undefined);

  if (!ready?.ok) throw new Error(`No stack at ${URL}: start one with \`pnpm stack\`.`);

  step("pairing the Mac (webmac)");
  const webmac = machine("webmac", path.join(REPO, "test-results/seed-stack"));
  const paired = await webmac.pair(URL, await pairingCode(URL));

  if (paired.code !== 0) throw new Error(`webmac did not pair: ${paired.output}`);

  return webmac.launch(URL);
}

async function main(): Promise<void> {
  const runner = await pairMac();

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: URL, viewport: { width: 1440, height: 900 } });
  await context.addCookies([await accessCookie(URL)]);
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: /^ky: Connected/ }).waitFor({ timeout: TIMEOUT });

  // The dream seeder forgets the first memory block, so it runs before any chat writes a memory.
  await dream(page);

  await seedChats(page);
  await seedRoutines(page);

  await browser.close();
  console.log(`\nSeeded ${URL}. The Mac stays up so the staging watch keeps running; Ctrl-C to stop it.`);

  const stop = async () => {
    await runner.stop();
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Executor, two specialists, four side chats and a main chat that starts every kind of task.
async function seedChats(page: Page): Promise<void> {
  step("connecting Executor");
  await executor(page);

  step("making specialists");
  await specialist(page, "builder", "Keeps the builds green and the PRs moving.", "Run the tests first. Small PRs, one idea each.");
  await specialist(page, "scout", "Finds places, prices and the best way there.", "Three options, cheapest first, with links.");

  step("side chats");
  await sideChat(page);
  await send(page, "Plan a long weekend in Lisbon in March", "Friday noon");
  await send(page, "Make a packing list I can open on my phone", "on your phone");
  await sideChat(page);
  await send(page, "Save how I order groceries as a skill", "order groceries");
  await send(page, "And a skill for planning the week's dinners", "which runs both");
  await sideChat(page);
  await send(page, "Publish the Q3 numbers as a page", "in Artifacts");
  await sideChat(page);
  await send(page, "Compare these three kitchen quotes", "2-year warranty");

  step("main chat");
  await sidebar(page).getByRole("button", { name: "Main chat" }).click();
  await send(page, "Morning! What's on today?", "draft that reply");
  await send(page, "How did my PRs do this week?", "waiting on review");
  await send(page, "Set up my usual routines", "Sundays and Wednesdays");
  await send(page, "Remember that Kai's jacket size is 4T", "shop for Kai");
  await send(page, "Give @builder an orange avatar", "new look");
  await send(page, "Find three flats in Lisbon for March, and check the trains from Porto", "Both show in Activity");
  await send(page, "Have the Mac run the test suite and fix anything flaky", "what it changed");
  await send(page, "Rebuild the search index on the Mac", "Started the rebuild");
  await send(page, "Watch the staging deploy and tell me if it breaks", "until the deploy finishes");
  await send(page, "How does a change get deployed?", "the config ky computes");
}

// Two routines run once and one paused, so the Routines sheet shows each state.
async function seedRoutines(page: Page): Promise<void> {
  step("running and pausing routines");
  const sheet = await routines(page);

  for (const title of ["Morning briefing", "Inbox digest"]) {
    await sheet.getByRole("listitem", { name: title }).getByRole("button", { name: "Run now" }).click();
    await page.waitForTimeout(1500);
  }

  const plants = sheet.getByRole("listitem", { name: "Water the plants" });
  const pause = plants.getByRole("button", { name: /^Pause/ });

  if (await pause.isVisible().catch(() => false)) await pause.click();
  else step("(no Pause button on Water the plants; left running)");
}

await main();
