import type { JsonValue } from "@earendil-works/pi-ai";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../automations/contract";
import { GLM, GPT_OSS, type PiAgent } from "./stack";
import { agent, connect, connectExecutor, FACTS, follow, gateStarted, inside, runner, snapshotView, until } from "./drive";

/**
 * Automations through ky's real PiAgent on the fake Workers AI: created and
 * changed from chat with `tool automation {...}`, fired by the object's
 * alarm (`runDurableObjectAlarm`), and checked by the task feed's rows and
 * the reports the chats hear.
 */

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Let a run that should not happen have its chance. */
const settle = () => pause(400);

const automation = (args: Record<string, JsonValue>) => `tool automation ${JSON.stringify(args)}`;

/** Say `text` in a chat, the main one unless `session` names a side chat; the agent's answer. */
async function say(name: string, text: string, session?: string): Promise<string> {
  return inside(name, async (instance) => (await instance.harness.prompt(text, { session })).text ?? "");
}

/** Ask for an automation, daily at 09:00 UTC unless `args` say otherwise; its id. */
/** A runner that pins models, with both agents installed. */
const PINS = { ...FACTS, models: true, agents: { claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true } } };

async function create(name: string, args: Record<string, JsonValue> = {}, session?: string): Promise<string> {
  const draft = { action: "create", title: "Daily digest", prompt: "digest the news", cron: "0 9 * * *", ...args };
  const said = await say(name, automation(draft), session);
  const id = /Created automation (\w+),/.exec(said)?.[1];

  if (!id) throw new Error(`Not created: ${said}`);

  return id;
}

/** Ask for a one-off a whole second about a second from now, so its run's slot is exactly its time. */
async function oneOff(name: string): Promise<{ at: Date; id: string }> {
  const at = new Date(Math.ceil((Date.now() + 1_000) / 1000) * 1000);
  const said = await say(name, automation({ action: "create", title: "Daily digest", prompt: "digest the news", at: at.toISOString() }));
  const id = /Created automation (\w+),/.exec(said)?.[1];

  if (!id) throw new Error(`Not created: ${said}`);

  return { at, id };
}

/** The automation's line in the tool's list, done and archived ones included. */
async function listed(name: string, id: string): Promise<string> {
  const said = await say(name, automation({ action: "list", all: true }));

  const lines = said.split("\n");
  const start = lines.findIndex((line) => line.includes(`${id} "`));

  if (start === -1) return "";
  // Each automation is a line of what it is, then indented ones: where it runs, when, and its gate's last check.
  const end = lines.findIndex((line, index) => index > start && !line.startsWith("  "));

  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** Run it now, as the user asks, and fire the object's alarm. */
async function runNow(name: string, id: string): Promise<void> {
  expect(await say(name, automation({ action: "run", id }))).toMatch(/^tool said: Running ".+" now/);
  await runDurableObjectAlarm(agent(name));
}

/** The automation's runs, as the task list shows them. */
function runs(name: string, id: string): Promise<TaskRow[]> {
  return inside(name, (instance) => instance.feed.list().filter((task) => task.source === `automation:${id}`));
}

async function runEnds(name: string, id: string, status = "done"): Promise<TaskRow> {
  await until(async () => (await runs(name, id)).some((task) => task.status === status), `a run of ${id} to be ${status}`);

  return (await runs(name, id)).find((task) => task.status === status)!;
}

/** What a chat (the main one unless `session`) was told that starts with `start`, such as a run's report. */
async function told(name: string, start: string, session?: string): Promise<string[]> {
  const view = await snapshotView(name, session);

  return view.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .filter((text) => text.startsWith(start));
}

/** What a post automation's run is told after its prompt. */
const POSTED_LINE = "Your answer is posted to the user as ky's own message, exactly as written: write only that message, no preamble.";

/** What ky said in a chat (the main one unless `session`), oldest first. */
async function kySaid(name: string, session?: string): Promise<string[]> {
  const view = await snapshotView(name, session);

  return view.messages.filter((message) => message.role === "assistant").map((message) => message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""));
}

/** What was handed over for the chat to hear, by its kind and what it says. */
function deliveries(name: string, session: string) {
  return inside(name, (_instance, state) =>
    state.storage.sql.exec<{ kind: string; content: string }>("SELECT kind, content FROM ky_deliveries WHERE session = ? ORDER BY created_at", session).toArray()
  );
}

/** A morning forecast, as a run would show it. */
const FORECAST = {
  title: "Kai's school day",
  blocks: [
    { type: "status", tone: "success", text: "Dry at drop-off" },
    { type: "stats", items: [{ label: "High", value: "18°" }, { label: "Rain", value: "10%" }] }
  ]
};

/** What the ui tool tells a run that kept its card. */
const KEPT = "Kept: the card is posted to the user before your report once this run succeeds.";

/** The text of a user's message. */
const userText = (message: { parts: readonly { type: string; text?: string }[] }) => message.parts.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");

/** The cards posted in a chat (the main one unless `session`), as their calls' arguments, oldest first. */
async function cardsIn(name: string, session?: string): Promise<JsonValue[]> {
  const view = await snapshotView(name, session);

  return view.messages.flatMap((message) => (message.posted ? message.parts.flatMap((part) => (part.type === "tool-call" && part.name === "ui" ? [part.arguments] : [])) : []));
}

/** The reports of the automation titled `title` a chat was given. */
const reports = (name: string, title: string, session?: string) => told(name, `[automation "${title}" result`, session);

/** The Scheduler's automation fires; the nightly dream is booked beside them. */
const automationFires = async (instance: PiAgent) =>
  (await instance.automations.scheduler.list()).filter((schedule) => schedule.callback === "automation");

/** The Scheduler's booking for the automation, if any. */
function booking(name: string, id: string) {
  return inside(name, async (instance) => {
    const scheduleId = instance.automations.get(id)?.schedule_id;

    return scheduleId ? instance.automations.scheduler.get(scheduleId) : undefined;
  });
}

/** Deliver the same fire again, as the Scheduler may: the same slot, booked once more and fired. */
async function fireAgain(name: string, id: string, slot: number): Promise<void> {
  await inside(name, (instance) => instance.automations.scheduler.set(new Date(), "automation", { id, slot }));
  await runDurableObjectAlarm(agent(name));
}

const slotOf = (task: TaskRow) => Number(task.id.split("-").at(-1));

/** A scheduled fire of the automation now, as its cron's would be: no slot of its own, so its gate decides. */
async function fire(name: string, id: string): Promise<void> {
  await inside(name, (instance) => instance.automations.scheduler.set(new Date(), "automation", { id }));
  await runDurableObjectAlarm(agent(name));
}

/** The next time a daily cron at `hour`:`minute` UTC fires after now, as the list prints it. */
function nextDaily(hour: number, minute = 0): string {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);

  return new Date(today > now.getTime() ? today : today + 86_400_000).toISOString();
}

/** The booking of a daily cron at `hour`:`minute`, in UTC while the user's zone is unknown: a one-off at its next time. */
const bookedDaily = (hour: number, minute = 0) => ({ type: "scheduled", time: Date.parse(nextDaily(hour, minute)) / 1000 });

/** The model calls an automation's runs made. */
function runCalls(name: string, id: string) {
  return inside(name, (instance) => instance.boundary.calls.filter((call) => call.system.includes(`automation-${id}`)));
}

describe("automations", () => {
  it("creates an automation from chat and books its schedule", async () => {
    const name = crypto.randomUUID();
    const said = await say(name, automation({ action: "create", title: "Daily digest", prompt: "digest the news", cron: "0 9 * * *" }));
    const id = /Created automation (\w+),/.exec(said)?.[1] ?? "";
    expect(said).toBe(`tool said: Created automation ${id}, "Daily digest" (cron 0 9 * * * UTC).`);

    const line = await listed(name, id);
    expect(line).toContain(`${id} "Daily digest" [active] cron 0 9 * * * UTC, by user`);
    expect(line).toContain("runs on: cloud · subagents model; reports to: main");
    expect(line).toContain(`next: ${nextDaily(9)}; last run: never`);

    expect(await booking(name, id)).toMatchObject({ ...bookedDaily(9), callback: "automation", payload: { id } });
    expect(await runs(name, id)).toEqual([]);
  });

  it("runs an automation on its own model and reports once to the chat that made it", async () => {
    const name = crypto.randomUUID();
    const id = await create(name, { model: `workers-ai/${GPT_OSS}` });

    await runNow(name, id);
    const run = await runEnds(name, id);
    expect(run).toMatchObject({ kind: "cloud", source: `automation:${id}`, title: "Daily digest" });
    // The background model may have renamed the summary already.
    expect(run.summary).toContain("echo: digest the news");
    expect(run.id).toMatch(new RegExp(`^a-${id}-\\d+$`));
    expect(await runs(name, id)).toHaveLength(1);

    // The worker is on GLM; the run asked GPT OSS.
    const calls = await runCalls(name, id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((call) => call.model)).toEqual(calls.map(() => GPT_OSS));

    await until(async () => (await reports(name, "Daily digest")).length > 0, "the report");
    await settle();
    expect(await reports(name, "Daily digest")).toEqual(['[automation "Daily digest" result: tell the user] echo: digest the news']);
    expect(await deliveries(name, ROOT_SESSION)).toMatchObject([{ kind: "event" }]);
    expect(await listed(name, id)).toMatch(/last run: done: .*echo: digest the news/);
  });

  it("posts a post automation's report in its chat as ky's own message, as written, starting no turn", async () => {
    const name = crypto.randomUUID();
    const id = await create(name, { post: true });
    expect(await listed(name, id)).toContain("reports to: main, posted as ky's message");

    await runNow(name, id);
    await runEnds(name, id);
    await until(async () => (await kySaid(name)).some((text) => text.startsWith("echo: digest the news")), "the post");
    await settle();

    // The run was told its answer is posted as written; the fake model echoes its whole message.
    const said = `echo: digest the news\n\n${POSTED_LINE}`;
    expect(await deliveries(name, ROOT_SESSION)).toEqual([{ kind: "post", content: said }]);
    // Last in the chat with no answer to it, and the chat's agent was never given it.
    expect((await kySaid(name)).at(-1)).toBe(said);
    expect(await reports(name, "Daily digest")).toEqual([]);

    expect(await say(name, automation({ action: "update", id, post: false }))).toMatch(/^tool said: Updated/);
    expect(await listed(name, id)).not.toContain("posted as ky's message");
  });

  it("gives a run the ui tool, and posts its card in its chat, before the report the chat's agent is given", async () => {
    const name = crypto.randomUUID();
    const chat = await inside(name, (instance) => instance.newChat());
    const id = await create(name, { prompt: `tool ui ${JSON.stringify(FORECAST)}`, chat });

    await runNow(name, id);
    await runEnds(name, id);
    await until(async () => (await reports(name, "Daily digest", chat)).length > 0, "the report");

    // The run was offered ui, and the chat's agent was not given the run's tools.
    const [first] = await runCalls(name, id);
    expect(Object.keys(first?.tools ?? {})).toContain("ui");
    expect(await reports(name, "Daily digest", chat)).toEqual([`[automation "Daily digest" result, its card already shown to the user just above: tell the user the rest] tool said: ${KEPT}`]);

    // The card is ky's own, in the chat the run reports to, and the report comes after it; the main chat has neither.
    const view = await snapshotView(name, chat);
    const card = view.messages.findIndex((message) => message.posted && message.parts.some((part) => part.type === "tool-call" && part.name === "ui"));
    const report = view.messages.findIndex((message) => message.role === "user" && userText(message).startsWith('[automation "Daily digest" result'));
    expect(card).toBeGreaterThanOrEqual(0);
    expect(card).toBeLessThan(report);
    expect(view.messages[card]!.parts.map((part) => (part.type === "tool-call" ? [part.name, part.arguments] : part.type))).toEqual([["ui", FORECAST]]);
    expect(await cardsIn(name)).toEqual([]);
  });

  it("posts a post automation's card, then its report, both as ky's own", async () => {
    const name = crypto.randomUUID();
    const id = await create(name, { prompt: `tool ui ${JSON.stringify(FORECAST)}`, post: true });

    await runNow(name, id);
    await runEnds(name, id);
    await until(async () => (await kySaid(name)).some((text) => text === `tool said: ${KEPT}`), "the post");
    await settle();

    const posted = (await snapshotView(name)).messages.filter((message) => message.posted);
    expect(posted.map((message) => message.parts.map((part) => part.type))).toEqual([["tool-call"], ["text"]]);
    expect(await cardsIn(name)).toEqual([FORECAST]);
    expect(await reports(name, "Daily digest")).toEqual([]);
  });

  it("keeps what a run's card asks, for the user to answer in the chat; wait does nothing", async () => {
    const name = crypto.randomUUID();
    const asking = { ...FORECAST, wait: true, blocks: [...FORECAST.blocks, { type: "choice", label: "Pack an umbrella?", options: [{ label: "Yes" }] }, { type: "buttons", buttons: [{ label: "OK" }, { label: "Radar", url: "https://example.com/radar" }] }] };
    const id = await create(name, { prompt: `tool ui ${JSON.stringify(asking)}`, post: true });

    await runNow(name, id);
    // The run's turn went on past the call to its answer.
    const run = await runEnds(name, id);
    expect(run.summary).toContain("wait does nothing in a run");
    await until(async () => (await cardsIn(name)).length > 0, "the card");

    expect(run.summary).toContain("The user answers it in that chat");
    const { wait: _wait, ...posted } = asking;
    expect(await cardsIn(name)).toEqual([posted]);
  });

  it("gives a plain subagent no ui tool: only a run's cards go with its report", async () => {
    const name = crypto.randomUUID();
    const said = await say(name, `spawn helper tool ui ${JSON.stringify(FORECAST)}`);
    expect(said).toMatch(/^tool said: /);
    await until(async () => (await told(name, "[subagent helper answered")).length > 0, "the answer");
    expect((await told(name, "[subagent helper answered")).join("")).toContain("Tool ui is not available");
  });

  it("hands a post automation's failed run to the chat's agent, to tell the user", async () => {
    const name = crypto.randomUUID();
    // Escaped, so the chat's own turn is not refused; the run's prompt is model-refuses.
    const said = await say(name, 'tool automation {"action":"create","title":"Daily digest","prompt":"model\\u002drefuses","cron":"0 9 * * *","post":true}');
    const id = /Created automation (\w+),/.exec(said)?.[1] ?? "";

    await runNow(name, id);
    await runEnds(name, id, "failed");
    await until(async () => (await told(name, '[automation "Daily digest" failed')).length > 0, "the failure");
    expect(await deliveries(name, ROOT_SESSION)).toMatchObject([{ kind: "event" }]);
  });

  it("refuses a post on a machine: its report is posted from the cloud", async () => {
    const name = crypto.randomUUID();
    const said = await say(name, automation({ action: "create", title: "Daily digest", prompt: "digest", cron: "0 9 * * *", machine: "mac", post: true }));
    expect(said).toBe("tool said: A posted report runs in the cloud: ask ky to update it with post false first.");
  });

  it("an automations table from an older ky gains post, its automations reading as not posting", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);
    await inside(name, (_instance, state) => state.storage.sql.exec("ALTER TABLE ky_automations DROP COLUMN post"));

    await evictDurableObject(agent(name));
    expect(await inside(name, (instance) => instance.automations.get(id)?.post)).toBe(false);
    expect(await listed(name, id)).not.toContain("posted as ky's message");
  });

  it("runs one task and one report when a slot fires again during its run and after an eviction", async () => {
    const name = crypto.randomUUID();
    const id = await create(name, { prompt: "gate" });

    await runNow(name, id);
    await gateStarted(name, 1);
    const [run] = await runs(name, id);
    expect(run).toMatchObject({ status: "working", source: `automation:${id}` });

    // The same slot delivered again while the run works.
    await fireAgain(name, id, slotOf(run!));
    await settle();
    expect(await agent(name).gateRuns()).toBe(1);
    await agent(name).release();
    await runEnds(name, id);

    // The object stops and starts again, and the slot is delivered once more.
    await evictDurableObject(agent(name));
    await fireAgain(name, id, slotOf(run!));
    await settle();
    expect((await runs(name, id)).map((task) => [task.id, task.status])).toEqual([[run!.id, "done"]]);
    expect(await agent(name).gateRuns()).toBe(1);
    await until(async () => (await reports(name, "Daily digest")).length > 0, "the report");
    await settle();
    expect(await reports(name, "Daily digest")).toEqual(['[automation "Daily digest" result: tell the user] tool said: released after 1 runs']);
  });

  it("refuses a model that is not offered and runs a model-less automation on the worker's model", async () => {
    const name = crypto.randomUUID();
    const refused = await say(name, automation({ action: "create", title: "Daily digest", prompt: "digest", cron: "0 9 * * *", model: "workers-ai/missing" }));
    expect(refused).toMatch(/^tool said: workers-ai\/missing is not available\. Choose one of: /);
    expect(refused).toContain(`workers-ai/${GLM} (`);
    expect(refused).toContain(`; workers-ai/${GPT_OSS} (`);
    expect(await say(name, automation({ action: "list", all: true }))).toBe("tool said: No automations.");

    // The user moves the worker to GPT OSS in Settings.
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.frames.some((frame) => frame.type === "settings"));
    socket.send(JSON.stringify({ type: "set-model", id: "worker", purpose: "worker", choice: { provider: "workers-ai", modelId: GPT_OSS, thinkingLevel: "off" } }));
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === "worker"));
    socket.close();

    const id = await create(name);
    expect(await listed(name, id)).toContain("runs on: cloud · subagents model");
    await runNow(name, id);
    await runEnds(name, id);
    const calls = await runCalls(name, id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((call) => call.model)).toEqual(calls.map(() => GPT_OSS));
  });

  it("skips a slot while the last run is still working", async () => {
    const name = crypto.randomUUID();
    const id = await create(name, { prompt: "gate" });

    await runNow(name, id);
    await gateStarted(name, 1);
    // A later slot: run-now's slot is the second it was asked in.
    await pause(1_100);
    await runNow(name, id);
    await settle();
    expect((await runs(name, id)).map((task) => task.status)).toEqual(["working"]);
    expect(await agent(name).gateRuns()).toBe(1);

    await agent(name).release();
    await runEnds(name, id);
    expect(await runs(name, id)).toHaveLength(1);
    await until(async () => (await reports(name, "Daily digest")).length > 0, "the report");
    await settle();
    expect(await reports(name, "Daily digest")).toHaveLength(1);
  });

  it("pause stops the live run and books nothing more; resume books from now", async () => {
    const name = crypto.randomUUID();
    const id = await create(name, { prompt: "gate" });

    await runNow(name, id);
    await gateStarted(name, 1);
    expect(await say(name, automation({ action: "pause", id }))).toBe('tool said: Paused "Daily digest".');
    await runEnds(name, id, "stopped");
    await agent(name).release();
    await settle();

    expect(await booking(name, id)).toBeUndefined();
    expect(await listed(name, id)).toContain("[paused]");
    expect(await listed(name, id)).toContain("next: none; last run: stopped");
    expect(await say(name, automation({ action: "run", id }))).toBe('tool said: "Daily digest" is paused, not active. Resume it first.');
    expect(await reports(name, "Daily digest")).toEqual([]);

    expect(await say(name, automation({ action: "resume", id }))).toBe('tool said: Resumed "Daily digest".');
    expect(await listed(name, id)).toContain(`[active] cron 0 9 * * * UTC`);
    expect(await listed(name, id)).toContain(`next: ${nextDaily(9)}`);
    expect(await booking(name, id)).toMatchObject(bookedDaily(9));
    expect(await runs(name, id)).toHaveLength(1);
  });

  it("stop ends the live run and keeps the schedule; with no run going it says so", async () => {
    const name = crypto.randomUUID();
    const id = await create(name, { prompt: "gate" });

    await runNow(name, id);
    await gateStarted(name, 1);
    expect(await say(name, automation({ action: "stop", id }))).toBe(`tool said: Stopped "Daily digest"'s run.`);
    await runEnds(name, id, "stopped");
    await agent(name).release();
    await settle();

    expect(await listed(name, id)).toContain(`[active] cron 0 9 * * * UTC`);
    expect(await booking(name, id)).toMatchObject(bookedDaily(9));
    expect(await reports(name, "Daily digest")).toEqual([]);
    expect((await runs(name, id)).map((task) => task.status)).toEqual(["stopped"]);
    expect(await say(name, automation({ action: "stop", id }))).toBe('tool said: "Daily digest" has no run going.');
  });

  it("a view carries its newest runs, newest first, with when and how each went", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);

    await runNow(name, id);
    await runEnds(name, id);
    await pause(1_100);
    await runNow(name, id);
    await until(async () => (await runs(name, id)).length === 2 && (await runs(name, id)).every((task) => task.status === "done"), "two runs");

    const view = await inside(name, async (instance) => (await instance.automations.list(true)).find((each) => each.id === id));
    expect(view?.runs.map((run) => run.status)).toEqual(["done", "done"]);
    expect(view?.runs[0]?.created_at).toBeGreaterThan(view?.runs[1]?.created_at ?? Infinity);
    expect(view?.runs[0]?.finished_at).not.toBeNull();
    expect(view?.last_run?.id).toBe(view?.runs[0]?.id);
  });

  it("update rebooks the schedule", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);
    const before = await booking(name, id);

    expect(await say(name, automation({ action: "update", id, cron: "30 14 * * *", title: "Afternoon digest" }))).toBe(
      'tool said: Updated "Afternoon digest".'
    );
    expect(await listed(name, id)).toContain(`"Afternoon digest" [active] cron 30 14 * * * UTC`);
    expect(await listed(name, id)).toContain(`next: ${nextDaily(14, 30)}`);
    const after = await booking(name, id);
    expect(after).toMatchObject(bookedDaily(14, 30));
    expect(await inside(name, (instance) => instance.automations.scheduler.get(before!.id))).toBeUndefined();

    // A cron the Scheduler cannot read is refused, and the booking stays as it was.
    expect(await say(name, automation({ action: "update", id, cron: "not a cron" }))).toMatch(/^tool said: Cannot schedule "not a cron": /);
    expect(await listed(name, id)).toContain(`next: ${nextDaily(14, 30)}`);
    expect(await booking(name, id)).toMatchObject(bookedDaily(14, 30));
  });

  it("archive cancels the schedule; unarchive brings it back paused", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);

    expect(await say(name, automation({ action: "archive", id }))).toBe('tool said: Archived "Daily digest".');
    expect(await booking(name, id)).toBeUndefined();
    expect(await inside(name, (instance) => automationFires(instance))).toEqual([]);
    expect(await listed(name, id)).toContain("[archived]");
    expect(await say(name, automation({ action: "list" }))).toBe("tool said: No automations.");

    expect(await say(name, automation({ action: "unarchive", id }))).toBe('tool said: Unarchived "Daily digest"; it is paused.');
    expect(await listed(name, id)).toContain("[paused]");
    expect(await listed(name, id)).toContain("next: none");
    expect(await booking(name, id)).toBeUndefined();

    expect(await say(name, automation({ action: "resume", id }))).toBe('tool said: Resumed "Daily digest".');
    expect(await listed(name, id)).toContain(`next: ${nextDaily(9)}`);
  });

  it("Activity lists an archived automation, and unarchiving it from there brings it back paused", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);
    expect(await say(name, automation({ action: "archive", id }))).toBe('tool said: Archived "Daily digest".');

    const socket = await connect(name);
    const client = follow(socket);

    const listedAs = (status: string) =>
      client.frames.some((frame) => frame.type === "automations" && frame.automations.some((each) => each.id === id && each.status === status));

    try {
      await client.until(() => listedAs("archived"));
      socket.send(JSON.stringify({ type: "automation", id: "unarchive", automation: id, action: "unarchive" }));
      await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === "unarchive"));
      expect(client.frames.find((frame) => frame.type === "result" && frame.id === "unarchive")).toMatchObject({
        result: 'Unarchived "Daily digest"; it is paused.'
      });
      await client.until(() => listedAs("paused"));
      expect(await booking(name, id)).toBeUndefined();
    } finally {
      socket.close();
    }
  });

  it("a pause that lands while an update re-books wins: it stays paused with nothing booked", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);

    await inside(name, async (instance) => {
      const updating = instance.automations.update(id, { cron: "30 14 * * *" });

      expect(await instance.automations.pause(id)).toBe('Paused "Daily digest".');
      await updating;
    });

    expect(await listed(name, id)).toContain(`[paused] cron 30 14 * * * UTC`);
    expect(await booking(name, id)).toBeUndefined();
    expect(await inside(name, (instance) => automationFires(instance))).toEqual([]);
  });

  it("an archive that lands while a resume books wins", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);
    expect(await say(name, automation({ action: "pause", id }))).toBe('tool said: Paused "Daily digest".');

    await inside(name, async (instance) => {
      const resuming = instance.automations.resume(id);

      expect(await instance.automations.archive(id)).toBe('Archived "Daily digest".');
      expect(await resuming).toBe('"Daily digest" is archived, not paused or done.');
    });

    expect(await listed(name, id)).toContain("[archived]");
    expect(await inside(name, (instance) => automationFires(instance))).toEqual([]);
  });

  it("an update that sets only thinking keeps the automation's own model", async () => {
    const name = crypto.randomUUID();
    const id = await create(name, { model: `workers-ai/${GPT_OSS}` });

    expect(await say(name, automation({ action: "update", id, thinking: "high" }))).toBe('tool said: Updated "Daily digest".');
    expect(await listed(name, id)).toContain(`runs on: cloud · workers-ai/${GPT_OSS} `);
    expect(await listed(name, id)).not.toContain(GLM);
  });

  it("delete cancels the schedule and removes the automation, keeping its past runs", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);
    await runNow(name, id);
    await runEnds(name, id);

    expect(await say(name, automation({ action: "delete", id }))).toBe('tool said: Deleted "Daily digest".');
    expect(await inside(name, (instance) => automationFires(instance))).toEqual([]);
    expect(await listed(name, id)).toBe("");
    expect(await runs(name, id)).toHaveLength(1);
    expect(await say(name, automation({ action: "resume", id }))).toBe(`tool said: No automation ${id}.`);
  });

  it("update clears a model and a machine, and refuses an empty prompt", async () => {
    const name = crypto.randomUUID();
    const first = await runner(name, "mac", PINS);
    first.socket.close();
    const id = await create(name, { machine: "mac", agent: "codex", model: "gpt-6.1-sol", thinking: "high" });
    expect(await listed(name, id)).toContain("runs on: mac · Codex · gpt-6.1-sol high;");

    expect(await say(name, automation({ action: "update", id, model: "default", machine: "cloud" }))).toBe('tool said: Updated "Daily digest".');
    expect(await listed(name, id)).toContain("runs on: cloud · subagents model;");

    expect(await say(name, automation({ action: "update", id, prompt: " " }))).toBe("tool said: An automation needs a title and a prompt.");
  });

  it("refuses a model its runner can't run: none without an agent, an agent's in the cloud, any on a runner from before models", async () => {
    const name = crypto.randomUUID();
    const old = await runner(name);
    old.socket.close();
    const make = (args: Record<string, JsonValue>) => say(name, automation({ action: "create", title: "Daily digest", prompt: "digest", cron: "0 9 * * *", ...args }));

    expect(await make({ machine: "mac", model: `workers-ai/${GPT_OSS}` })).toBe("tool said: Pick the agent too: a model on a machine is its agent's.");
    expect(await make({ agent: "claude", model: "opus" })).toBe("tool said: An agent is picked only for a run on a machine; a run in the cloud is a subagent.");
    expect(await make({ model: "claude/opus" })).toBe("tool said: opus is Claude Code's: pick a machine for it, or a model ky offers.");
    expect(await make({ machine: "mac", agent: "claude", model: "gpt-6.1-sol" })).toBe("tool said: A run as Claude Code takes one of its models: fable, opus, sonnet, haiku.");
    expect(await make({ machine: "mac", agent: "codex" })).toBe("tool said: mac cannot run Codex: it is not installed there.");
    expect(await make({ machine: "mac", agent: "claude", model: "opus" })).toBe("tool said: mac's ky-runner is too old to pick a model; update ky on it (ky upgrade).");
    // The machine's own agent on its own model needs nothing of the runner.
    await create(name, { machine: "mac", agent: "claude" });
  });

  it("a machine automation runs as its agent on its model, every turn, and says why when its runner no longer can", async () => {
    const name = crypto.randomUUID();
    const first = await runner(name, "mac", PINS);
    first.socket.close();
    const id = await create(name, { machine: "mac", agent: "claude", model: "opus", thinking: "xhigh", prompt: "check the backups" });

    await runNow(name, id);
    const [run] = await runs(name, id);
    expect(run).toMatchObject({ kind: "machine", worker: "mac", status: "queued", agent: "claude" });
    const mac = await runner(name, "mac", PINS);
    expect(await mac.next()).toMatchObject({ type: "run", task: run!.id, agent: "claude", model: { id: "opus", effort: "xhigh" } });
    mac.send({ type: "result", task: run!.id, turn: 1, ok: true, text: "backups are fine", session: "s-backups", agent: "claude" });
    await runEnds(name, id);
    mac.socket.close();

    // The runner is put back to one from before models: the next run is refused, never run on its own model.
    const old = await runner(name);
    old.socket.close();
    expect(await listed(name, id)).toContain("(mac's ky-runner is too old to pick a model; update ky on it (ky upgrade).)");
    await runNow(name, id);
    await until(async () => (await runs(name, id)).some((each) => each.status === "failed"), "the refused run");
    expect((await runs(name, id)).find((each) => each.status === "failed")).toMatchObject({ summary: "mac's ky-runner is too old to pick a model; update ky on it (ky upgrade)." });
  });

  it("books lost schedules again when the object starts", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);

    // The booking is lost, as a storage reset or a failed migration would lose it.
    await inside(name, async (instance) => {
      for (const schedule of await instance.automations.scheduler.list()) await instance.automations.scheduler.cancel(schedule.id);
    });
    expect(await booking(name, id)).toBeUndefined();
    expect(await listed(name, id)).toContain("next: none");

    await evictDurableObject(agent(name));
    // The object starts when the browser opens it.
    const socket = await connect(name);
    await until(async () => (await booking(name, id)) !== undefined, "the booking to come back");
    socket.close();
    expect(await booking(name, id)).toMatchObject(bookedDaily(9));
    expect(await listed(name, id)).toContain(`next: ${nextDaily(9)}`);
  });

  it("a machine automation enqueues its run once when a slot fires twice", async () => {
    const name = crypto.randomUUID();
    // The machine is known from an earlier connection, and offline now.
    const first = await runner(name);
    first.socket.close();

    const id = await create(name, { machine: "mac", prompt: "check the backups" });
    await runNow(name, id);
    const [run] = await runs(name, id);
    expect(run).toMatchObject({ kind: "machine", worker: "mac", status: "queued", source: `automation:${id}` });
    await fireAgain(name, id, slotOf(run!));
    expect(await runs(name, id)).toHaveLength(1);

    const mac = await runner(name);
    const command = await mac.next();
    expect(command).toMatchObject({ type: "run", task: run!.id, prompt: "check the backups", session: null });
    mac.send({ type: "session", task: run!.id, turn: 1, session: "s-backups" });
    await until(async () => (await runs(name, id))[0]?.status === "working", "the run to work");

    // Delivered again while it works, and again after the object is evicted mid-run.
    await fireAgain(name, id, slotOf(run!));
    await evictDurableObject(agent(name));
    await fireAgain(name, id, slotOf(run!));
    await settle();
    expect(mac.commands).toEqual([]);

    mac.send({ type: "result", task: run!.id, turn: 1, ok: true, text: "backups are fine", session: "s-backups", agent: "claude" });
    await runEnds(name, id);

    const machineReports = () => told(name, `[machine mac, task ${run!.id} `);

    await until(async () => (await machineReports()).length > 0, "the report");
    await settle();
    expect(await machineReports()).toHaveLength(1);
    expect((await machineReports())[0]).toContain("backups are fine");
    expect(await runs(name, id)).toHaveLength(1);
    mac.socket.close();
  });

  it("a machine automation on a machine the user paused fails its run and queues nothing", async () => {
    const name = crypto.randomUUID();
    const first = await runner(name);
    first.socket.close();
    await inside(name, (instance) => instance.machines.change("mac", { state: "paused" }));

    const id = await create(name, { machine: "mac", prompt: "check the backups" });
    await runNow(name, id);
    const [run] = await runs(name, id);
    expect(run).toMatchObject({ kind: "machine", status: "failed", summary: "mac is paused: the user is not letting it take new tasks." });

    const mac = await runner(name);
    await settle();
    expect(mac.commands).toEqual([]);
    mac.socket.close();
  });

  it("ky schedules a one-off for itself, which runs, reports, and ends done", async () => {
    const name = crypto.randomUUID();
    // A whole second about a second from now, so the run's slot is exactly its time.
    const at = new Date(Math.ceil((Date.now() + 1_000) / 1000) * 1000);
    const ask = { action: "create", title: "Check the deploy", prompt: "check the deploy", at: at.toISOString(), createdBy: "ky" };
    const said = await say(name, automation(ask));

    const id = /Created automation (\w+),/.exec(said)?.[1] ?? "";
    expect(said).toBe(`tool said: Created automation ${id}, "Check the deploy" (once at ${at.toISOString()}).`);
    expect(await listed(name, id)).toContain(`[active] once at ${at.toISOString()}, by ky`);
    expect(await listed(name, id)).toContain(`next: ${at.toISOString()}`);

    await pause(Math.max(0, at.getTime() - Date.now()) + 100);
    await runDurableObjectAlarm(agent(name));
    const run = await runEnds(name, id);
    expect(run.id).toBe(`a-${id}-${at.getTime() / 1000}`);
    await until(async () => (await reports(name, "Check the deploy")).length > 0, "the report");
    expect(await reports(name, "Check the deploy")).toEqual(['[automation "Check the deploy" result: tell the user] echo: check the deploy']);

    expect(await listed(name, id)).toContain("[done]");
    expect(await listed(name, id)).toContain("next: none");
    expect(await booking(name, id)).toBeUndefined();
    expect(await say(name, automation({ action: "list" }))).toBe("tool said: No automations.");
    await runDurableObjectAlarm(agent(name));
    await settle();
    expect(await runs(name, id)).toHaveLength(1);
  });

  it("a one-off paused while it fires stays paused and posts no report", async () => {
    const name = crypto.randomUUID();
    const { at, id } = await oneOff(name);

    // The user pauses it in the moment between the run's commit and the fire's end: when the fire wakes pi.
    await inside(name, (instance) => {
      const wake = instance.harness.onStart.bind(instance.harness);

      instance.harness.onStart = async (context) => {
        await instance.automations.pause(id);
        await wake(context);
      };
    });

    await pause(Math.max(0, at.getTime() - Date.now()) + 100);
    await runDurableObjectAlarm(agent(name));
    await runEnds(name, id, "stopped");
    await settle();

    expect(await listed(name, id)).toContain("[paused]");
    expect(await booking(name, id)).toBeUndefined();
    expect(await reports(name, "Daily digest")).toEqual([]);
    expect(await runs(name, id)).toHaveLength(1);
  });

  it("a one-off whose slot already ran ends done, and resuming it is refused", async () => {
    const name = crypto.randomUUID();
    const { at, id } = await oneOff(name);

    await pause(Math.max(0, at.getTime() - Date.now()) + 100);
    await runDurableObjectAlarm(agent(name));
    const run = await runEnds(name, id);

    // The object was evicted after the run started and before the fire marked it done.
    await inside(name, (_instance, state) => {
      state.storage.sql.exec("UPDATE ky_automations SET status = 'active' WHERE id = ?", id);
    });
    await fireAgain(name, id, slotOf(run));
    await settle();

    expect(await listed(name, id)).toContain("[done]");
    expect(await runs(name, id)).toHaveLength(1);
    expect(await say(name, automation({ action: "resume", id }))).toBe(
      `tool said: "Daily digest" ran at ${at.toISOString()}. Update \`at\` to run it again.`
    );
    expect(await listed(name, id)).toContain("[done]");
  });

  it("a gate that finds nothing skips the fire; one that finds something runs with it before the prompt", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const said = await say(name, automation({ action: "create", title: "School mail", prompt: "tell me what school sent", cron: "*/15 * * * *", gate: "answer null" }));
    expect(said).toMatch(/^tool said: Created automation \w+, "School mail" \(cron \*\/15 \* \* \* \* UTC\)\.\nGate test: returned nothing \(null\), so a fire now would be skipped\.$/);
    const id = /Created automation (\w+),/.exec(said)![1]!;

    await fire(name, id);
    await settle();
    expect(await runs(name, id)).toEqual([]);
    expect(await listed(name, id)).toMatch(/gate: last check \S+, nothing$/);
    expect(await reports(name, "School mail")).toEqual([]);

    const updated = await say(name, automation({ action: "update", id, gate: "answer [\"Trip form due Friday\"]" }));
    expect(updated).toBe('tool said: Updated "School mail".\nGate test: found 1 item, so a fire now would run with it before its prompt:\n["Trip form due Friday"]');

    await fire(name, id);
    await runEnds(name, id);
    await until(async () => (await reports(name, "School mail")).length > 0, "the report");
    expect((await reports(name, "School mail"))[0]).toContain('Gate found:\n["Trip form due Friday"]\n\ntell me what school sent');
    expect(await listed(name, id)).toMatch(/gate: last check \S+, found: \["Trip form due Friday"\]$/);
  });

  it("a gate that returns an empty list or object skips the fire, and only its value goes before the prompt", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const said = await say(name, automation({ action: "create", title: "School mail", prompt: "tell me what school sent", cron: "*/15 * * * *", gate: "answer []" }));
    expect(said).toMatch(/\nGate test: returned nothing \(\[\]\), so a fire now would be skipped\.$/);
    const id = /Created automation (\w+),/.exec(said)![1]!;

    await fire(name, id);
    expect(await say(name, automation({ action: "update", id, gate: "answer {}" }))).toBe(
      'tool said: Updated "School mail".\nGate test: returned nothing ({}), so a fire now would be skipped.'
    );
    await fire(name, id);
    await settle();
    expect(await runs(name, id)).toEqual([]);
    expect(await listed(name, id)).toMatch(/gate: last check \S+, nothing$/);

    expect(await say(name, automation({ action: "update", id, gate: 'answer {"unread":2}' }))).toBe(
      'tool said: Updated "School mail".\nGate test: found something, so a fire now would run with it before its prompt:\n{"unread":2}'
    );
    await fire(name, id);
    await runEnds(name, id);
    await until(async () => (await reports(name, "School mail")).length > 0, "the report");
    const [report] = await reports(name, "School mail");
    expect(report).toContain('Gate found:\n{"unread":2}\n\ntell me what school sent');
    // The run gets what the program returned, not Executor's envelope around it.
    expect(report).not.toContain("execution");
  });

  it("a gate whose program fails or asks for approval is a failed check, never a run", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const said = await say(name, automation({ action: "create", title: "School mail", prompt: "check", cron: "*/15 * * * *", gate: "throw gmail is not connected" }));
    expect(said).toContain("\nGate test failed: gmail is not connected. Fix it with update; three failed fires in a row pause it.");
    const id = /Created automation (\w+),/.exec(said)![1]!;

    await fire(name, id);
    await settle();
    expect(await listed(name, id)).toMatch(/gate: last check \S+, error: gmail is not connected$/);

    expect(await say(name, automation({ action: "update", id, gate: "approve send mail" }))).toContain(
      "\nGate test failed: it asked for an approval or input; a gate may only read."
    );
    await fire(name, id);
    await settle();
    expect(await listed(name, id)).toMatch(/gate: last check \S+, error: it asked for an approval/);
    expect(await runs(name, id)).toEqual([]);
  });

  it("run now runs whatever the gate says, and clearing the gate runs every fire", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const id = await create(name, { gate: "answer []" });

    await runNow(name, id);
    await runEnds(name, id);
    expect((await runs(name, id))[0]!.summary).toContain("echo: digest the news");

    expect(await say(name, automation({ action: "update", id, gate: "none" }))).toBe('tool said: Updated "Daily digest".');
    expect(await listed(name, id)).not.toContain("gate:");
    await pause(1_100);
    await fire(name, id);
    await until(async () => (await runs(name, id)).length === 2, "the ungated fire's run");
  });

  it("three failed gates in a row pause the automation and tell its chat", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const said = await say(name, automation({ action: "create", title: "School mail", prompt: "check", cron: "*/15 * * * *", gate: "fail no tool gmail.search" }));
    expect(said).toContain("\nGate test failed: no tool gmail.search. Fix it with update; three failed fires in a row pause it.");
    const id = /Created automation (\w+),/.exec(said)![1]!;

    await fire(name, id);
    await fire(name, id);
    expect(await listed(name, id)).toMatch(/\[active\][\s\S]*gate: last check \S+, error: no tool gmail\.search$/);
    expect(await told(name, '[automation "School mail" paused]')).toEqual([]);

    await fire(name, id);
    await until(async () => (await told(name, '[automation "School mail" paused]')).length > 0, "the pause notice");
    expect(await told(name, '[automation "School mail" paused]')).toEqual([
      '[automation "School mail" paused] Its gate failed 3 fires in a row; the last said: no tool gmail.search. Fix the gate (automation update) and resume it.'
    ]);
    expect(await listed(name, id)).toContain("[paused]");
    expect(await booking(name, id)).toBeUndefined();
    expect(await runs(name, id)).toEqual([]);
  });

  it("a gate without Executor connected fails its test", async () => {
    const name = crypto.randomUUID();
    const said = await say(name, automation({ action: "create", title: "School mail", prompt: "check", cron: "*/15 * * * *", gate: "answer x" }));
    expect(said).toContain("\nGate test failed: Executor is not connected.");
  });

  it("reports to the side chat that made it, unarchiving it if needed", async () => {
    const name = crypto.randomUUID();
    const chat = await inside(name, (instance) => instance.newChat());
    const id = await create(name, {}, chat);
    expect(await listed(name, id)).toContain(`reports to: untitled (${chat})`);

    await inside(name, (instance) => instance.chats.archive(chat, true));
    const archived = () => inside(name, (instance) => instance.chats.list().find((row) => row.session === chat)?.archived_at ?? null);
    expect(await archived()).not.toBeNull();
    const updated = () => inside(name, (instance) => instance.chats.list().find((row) => row.session === chat)?.updated_at ?? 0);
    const before = await updated();
    await pause(5);

    await runNow(name, id);
    await runEnds(name, id);
    await until(async () => (await reports(name, "Daily digest", chat)).length > 0, "the side chat's report");
    expect(await archived()).toBeNull();
    // ky's answer to the report moves the chat up the sidebar, though no one wrote in it.
    await until(async () => (await updated()) > before, "the side chat to move");
    expect(await reports(name, "Daily digest")).toEqual([]);

    // Sent to main instead, the next run reports there.
    expect(await say(name, automation({ action: "update", id, chat: "main" }))).toBe('tool said: Updated "Daily digest".');
    expect(await listed(name, id)).toContain("reports to: main");
    await pause(1_100);
    await runNow(name, id);
    await until(async () => (await reports(name, "Daily digest", ROOT_SESSION)).length > 0, "the main chat's report");
    await until(async () => (await inside(name, (instance) => instance.chats.mainUpdatedAt())) > 0, "the main chat to move");
    expect(await reports(name, "Daily digest", chat)).toHaveLength(1);
    expect(await runs(name, id)).toHaveLength(2);
  });

  it("reports while the user is away: an archived side chat comes back for it, and a deleted one's go to main", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.presence.seen(Date.now() - 2 * 3_600_000);
    });
    const chat = await inside(name, (instance) => instance.newChat());
    const id = await create(name, {}, chat);

    await inside(name, (instance) => instance.chats.archive(chat, true));
    await runNow(name, id);
    await runEnds(name, id);
    await until(async () => (await reports(name, "Daily digest", chat)).length > 0, "the archived side chat's report");
    expect(await inside(name, (instance) => instance.chats.list().find((row) => row.session === chat)?.archived_at ?? null)).toBeNull();

    // The side chat is gone: the next run reports to main.
    await inside(name, (_instance, state) => state.storage.sql.exec("DELETE FROM ky_chats WHERE session = ?", chat));
    await pause(1_100);
    await runNow(name, id);
    await until(async () => (await reports(name, "Daily digest", ROOT_SESSION)).length > 0, "the main chat's report");
    expect(await reports(name, "Daily digest", chat)).toHaveLength(1);
  });
});

/**
 * Check-ins: one-offs the nightly dream books for something the user asked
 * about with a date ahead. A dream's conversation calls the automation tool
 * as the dream would; a run's answer comes from its prompt (`reply: TEXT`).
 */
describe("check-ins", () => {
  /** A conversation the dream's rules apply to, as a dream's is. */
  const dream = (name: string) =>
    inside(name, async (instance) => {
      const { id } = await instance.harness.sessions.create();
      instance.reviews.add(id, "", "dream");

      return id;
    });

  /** Book a check-in from a dream an hour from now; what the tool said. */
  async function book(name: string, session: string, args: Record<string, JsonValue> = {}): Promise<string> {
    const at = new Date(Date.now() + 3_600_000).toISOString();

    // A null at leaves it out.
    const given = Object.fromEntries(Object.entries({ action: "create", title: "Advance polls", prompt: "reply: NOTHING_NEW", at, ...args }).filter(([, value]) => value !== null));

    return say(name, automation(given), session);
  }

  const booked = (said: string) => {
    const id = /Created automation (\w+),/.exec(said)?.[1];

    if (!id) throw new Error(`Not booked: ${said}`);

    return id;
  };

  const checkIns = (name: string, session?: string) => told(name, "[check-in", session);

  it("a dream books a one-off check-in that reports to the main chat, and may do nothing else", async () => {
    const name = crypto.randomUUID();
    const session = await dream(name);
    // The dream names its own conversation, a model and a post; a check-in ignores them.
    const id = booked(await book(name, session, { chat: session, model: `workers-ai/${GPT_OSS}`, post: true }));

    expect(await inside(name, (instance) => instance.automations.get(id))).toMatchObject({
      created_by: "dream",
      chat: ROOT_SESSION,
      model: null,
      machine: null,
      post: false,
      status: "active"
    });
    // Its report goes to the main agent, which checks memory before it tells the user, so a dream's posted one is refused.
    const posted = { title: "Polls", prompt: "polls", cron: null, at: Date.now() + 3_600_000, model: null, machine: null, agent: null, chat: ROOT_SESSION, gate: null, post: true };
    expect(await inside(name, (instance) => instance.automations.create(posted, "dream"))).toEqual({ refused: "A check-in's report goes to the main agent, not posted." });

    expect(await book(name, session, { at: null, cron: "0 9 * * *" })).toBe("tool said: A check-in runs once: give at, not cron.");
    expect(await book(name, session, { at: new Date(Date.now() - 60_000).toISOString() })).toBe("tool said: A check-in's time must be ahead.");
    expect(await say(name, automation({ action: "pause", id }), session)).toBe("tool said: A dream may only create check-ins and list automations.");
    // Nor can an update from the user's chat make it post.
    expect(await say(name, automation({ action: "update", id, post: true }))).toBe("tool said: A check-in's report goes to the main agent, not posted.");
    expect(await inside(name, (instance) => instance.automations.get(id)?.post)).toBe(false);
  });

  it("books at most two a day, and none once the user turns them off, which pauses the waiting ones", async () => {
    const name = crypto.randomUUID();
    const session = await dream(name);
    const first = booked(await book(name, session));
    booked(await book(name, session));
    expect(await book(name, session)).toBe("tool said: 2 check-ins were booked in the last day; that is the limit.");

    await inside(name, (instance) => instance.automations.setCheckIns(false));
    expect(await inside(name, (instance) => instance.automations.get(first)?.status)).toBe("paused");
    expect(await booking(name, first)).toBeUndefined();
    expect(await book(name, session)).toBe("tool said: The user turned check-ins off.");

    // The user's own automations do not count against it.
    await create(name);
  });

  it("stays out of the chat when it finds nothing new", async () => {
    const name = crypto.randomUUID();
    const id = booked(await book(name, await dream(name)));

    await runNow(name, id);
    const run = await runEnds(name, id);
    expect(run.summary).toBe("Nothing new");
    await settle();
    expect(await checkIns(name)).toEqual([]);
  });

  it("brings what it found to the main agent to tell the user", async () => {
    const name = crypto.randomUUID();
    const id = booked(await book(name, await dream(name), { prompt: "reply: Kids Vote Weekend at the advance polls today" }));

    await runNow(name, id);
    await runEnds(name, id);
    await until(async () => (await checkIns(name)).length > 0, "the check-in's report");
    const [report] = await checkIns(name);
    expect(report).toMatch(/^\[check-in "Advance polls" found something new: .*memory_note what you told them\] Kids Vote Weekend at the advance polls today$/s);
  });

  it("may only search and read the web", async () => {
    const name = crypto.randomUUID();
    const prompt = `tool skill_manage ${JSON.stringify({ action: "create", name: "x", content: "y" })}`;
    const id = booked(await book(name, await dream(name), { prompt }));

    await runNow(name, id);
    await runEnds(name, id);
    await until(async () => (await checkIns(name)).length > 0, "the check-in's report");
    expect((await checkIns(name))[0]).toContain("Tool call blocked: A check-in may only call executor_skills, executor_execute, browse.");
  });

  it("the dream is told how to book them, with the time zone and the ones waiting, only while they are on", async () => {
    const name = crypto.randomUUID();
    const on = { on: true, zone: "America/Toronto", waiting: ['- 2026-10-12T12:00:00.000Z "Advance polls"'] };
    await say(name, `tool memory_note ${JSON.stringify({ text: "The user asked where to vote in Ward 17 on October 12." })}`);

    const digest = await inside(name, (instance) => instance.dreaming.digest({ memories: 0, at: 0 }, on));
    expect(digest).toContain("the user's time zone: America/Toronto.");
    expect(digest).toContain('Check-ins waiting:\n- 2026-10-12T12:00:00.000Z "Advance polls"');

    const off = await inside(name, (instance) => instance.dreaming.digest({ memories: 0, at: 0 }, { ...on, on: false }));
    expect(off).not.toContain("Check-ins waiting");
  });
});

describe("automations in the user's time zone", () => {
  // Intl may spell Kolkata by its old name.
  const KOLKATA_CRON = /\[active\] cron 0 9 \* \* 1-5 Asia\/(Kolkata|Calcutta),/;

  /** The next 9:00 on a weekday in Kolkata (UTC+5:30, no daylight saving) after now, epoch seconds. */
  function nextKolkataWeekday(): number {
    for (let day = 0; ; day++) {
      const now = Date.now();
      const date = new Date(now + 330 * 60_000 + day * 86_400_000);
      const at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 9) - 330 * 60_000;
      const weekday = new Date(at + 330 * 60_000).getUTCDay();

      if (at > now && weekday >= 1 && weekday <= 5) return at / 1000;
    }
  }

  it("books a cron at its next time in the user's zone, and the zone shows in the list", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => instance.automations.pinZone("Asia/Kolkata"));
    const id = await create(name, { cron: "0 9 * * 1-5" });

    expect(await listed(name, id)).toMatch(KOLKATA_CRON);
    expect(await booking(name, id)).toMatchObject({ type: "scheduled", time: nextKolkataWeekday() });
  });

  it("a fire books the next time before it runs, once however often it is delivered", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => instance.automations.pinZone("Asia/Kolkata"));
    const id = await create(name, { cron: "0 9 * * 1-5" });

    // Its booking comes due now, as the alarm would find it at 9 AM.
    await inside(name, async (instance, state) => {
      const old = instance.automations.get(id)?.schedule_id;

      if (old) await instance.automations.scheduler.cancel(old);
      const due = await instance.automations.scheduler.set(new Date(), "automation", { id });
      state.storage.sql.exec("UPDATE ky_automations SET schedule_id = ? WHERE id = ?", due.id, id);
    });
    await runDurableObjectAlarm(agent(name));
    await until(async () => (await runs(name, id)).length === 1, "the run to start");

    expect(await booking(name, id)).toMatchObject({ type: "scheduled", time: nextKolkataWeekday() });
    expect((await inside(name, automationFires)).length).toBe(1);
  });

  it("moves with the user's zone, and moves a UTC cron from before into it", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => instance.automations.pinZone("Europe/Berlin"));
    const id = await create(name, { cron: "0 9 * * 1-5" });
    const legacy = await create(name, { title: "Old digest" });

    // Written when crons were UTC: 03:30 UTC on weekdays is 09:00 in Kolkata.
    await inside(name, (_instance, state) => state.storage.sql.exec("UPDATE ky_automations SET zone = 'UTC', cron = '30 3 * * 1-5' WHERE id = ?", legacy));
    await inside(name, (instance) => instance.automations.pinZone("Asia/Kolkata"));

    expect(await listed(name, id)).toMatch(KOLKATA_CRON);
    expect(await booking(name, id)).toMatchObject({ type: "scheduled", time: nextKolkataWeekday() });
    expect(await listed(name, legacy)).toMatch(KOLKATA_CRON);
    expect(await booking(name, legacy)).toMatchObject({ type: "scheduled", time: nextKolkataWeekday() });
  });
});
