import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { agent, browser, fire, gateStarted, inside, type Tab } from "./drive";
import { EXECUTOR_TOKEN, EXECUTOR_URL } from "./stack";

/**
 * An automation's fire, as its alarm runs it, through to the user (src/automations/automations.ts and delivery.ts),
 * driven from the browser: its gate decides whether the run is worth waking for, and its report goes into the chat
 * once the chat's turn is over, in full, even with Settings › Proactivity at boundary and the user away.
 */

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const REPORT = '[automation "School mail" result';

/** The reports the page's chat shows. */
const reports = (page: Tab) =>
  page.view().messages.filter((message) => message.role === "user" && message.parts.some((part) => part.type === "text" && part.text.startsWith(REPORT)));

/** The runs of `id` Activity shows, ended with `status`. */
const runs = (page: Tab, id: string, status: string) =>
  (page.latest("tasks")?.tasks ?? []).filter((task) => task.source === `automation:${id}` && task.status === status);

/** Save "School mail" from the page as the user does, its gate finding `found`; its id. */
async function save(page: Tab, found: readonly string[], id?: string, prompt = "tell me what school sent"): Promise<string> {
  const draft = { title: "School mail", prompt, cron: "*/15 * * * *", at: null, model: null, machine: null, agent: null, chat: ROOT_SESSION, gate: `answer ${JSON.stringify(found)}` };
  expect(await page.send({ type: "automation-save", automation: id, draft })).toMatchObject({ type: "result", result: {} });
  await page.until(() => page.latest("automations")?.automations.some((each) => each.title === "School mail" && each.gate === draft.gate && each.prompt === prompt) === true);

  return page.latest("automations")!.automations.find((each) => each.title === "School mail")!.id;
}

/** A page with Executor connected, whose user just said hello. */
async function ready(name: string): Promise<Tab> {
  const page = await browser(name);
  expect(await page.send({ type: "set-executor", url: EXECUTOR_URL, token: EXECUTOR_TOKEN })).toMatchObject({ type: "result" });
  await page.say("hello");

  return page;
}

describe("an automation's fire", () => {
  it("reports to the chat, skips what the last run found, runs again what a failed run found, and reports in full while the user is away", async () => {
    const name = crypto.randomUUID();
    const page = await ready(name);
    const id = await save(page, ["Trip form due Friday"]);

    await fire(name, id);
    await page.until(() => reports(page).length === 1);

    // Fires a second apart are separate slots. The same finding: no run.
    await pause(1_100);
    await fire(name, id);
    await pause(400);
    expect(runs(page, id, "done")).toHaveLength(1);

    // Something new, and a prompt the model refuses: the run fails. Mended, the next fire runs on that finding again.
    await save(page, ["Trip form due Friday", "Pizza day"], id, "tell me what school sent model-refuses");
    await pause(1_100);
    await fire(name, id);
    await page.until(() => runs(page, id, "failed").length === 1);
    await save(page, ["Trip form due Friday", "Pizza day"], id);
    await pause(1_100);
    await fire(name, id);
    await page.until(() => runs(page, id, "done").length === 2);
    await page.until(() => reports(page).length === 2);

    // Seed: the user last sent a message two hours ago. The next finding still goes to the chat, in full.
    await inside(name, (instance) => instance.presence.seen(Date.now() - 2 * 3_600_000));
    await save(page, ["Trip form due Friday", "Pizza day", "Book fair"], id);
    await pause(1_100);
    await fire(name, id);
    await page.until(() => reports(page).length === 3);
    expect(reports(page)[2]!.parts.some((part) => part.type === "text" && part.text.includes("Book fair"))).toBe(true);
    page.close();
  });

  it("reports into a chat whose turn the user stopped, once it stops", async () => {
    const name = crypto.randomUUID();
    const page = await ready(name);
    const id = await save(page, ["Trip form due Friday"]);
    expect(await page.send({ type: "submit", input: "gate" })).toMatchObject({ type: "result" });
    await gateStarted(name, 1);

    await fire(name, id);
    await page.until(() => runs(page, id, "done").length === 1);
    await pause(400);
    expect(reports(page)).toEqual([]);

    expect(await page.send({ type: "abort" })).toMatchObject({ type: "result" });
    await page.until(() => reports(page).length === 1);
    await agent(name).release();
    page.close();
  });
});
