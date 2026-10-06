import type { JsonValue } from "@earendil-works/pi-ai";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../tasks";
import { agent, connect, follow, gateStarted, inside, runner, snapshotView, until } from "./drive";

/**
 * Automations through ky's real PiAgent on the faux model: created and
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

  // Each automation is three lines: what it is, where it runs, and when.
  return start === -1 ? "" : lines.slice(start, start + 3).join("\n");
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

/** The reports of the automation titled `title` a chat was given. */
const reports = (name: string, title: string, session?: string) => told(name, `[automation "${title}" result`, session);

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

/** The next time a daily cron at `hour`:`minute` UTC fires after now, as the list prints it. */
function nextDaily(hour: number, minute = 0): string {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);

  return new Date(today > now.getTime() ? today : today + 86_400_000).toISOString();
}

/** The faux model calls an automation's runs made. */
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
    expect(line).toContain("model: subagents slot; where: cloud; reports to: main");
    expect(line).toContain(`next: ${nextDaily(9)}; last run: never`);

    expect(await booking(name, id)).toMatchObject({ type: "cron", cron: "0 9 * * *", callback: "automation", payload: { id } });
    expect(await runs(name, id)).toEqual([]);
  });

  it("runs an automation on its own model and reports once to the chat that made it", async () => {
    const name = crypto.randomUUID();
    const id = await create(name, { model: "faux/faux-text" });

    await runNow(name, id);
    const run = await runEnds(name, id);
    expect(run).toMatchObject({ kind: "cloud", source: `automation:${id}`, title: "Daily digest" });
    // The titles model may have renamed the summary already.
    expect(run.summary).toContain("echo: digest the news");
    expect(run.id).toMatch(new RegExp(`^a-${id}-\\d+$`));
    expect(await runs(name, id)).toHaveLength(1);

    // The subagents slot is faux/faux; the run asked faux-text.
    const calls = await runCalls(name, id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((call) => call.model)).toEqual(calls.map(() => "faux-text"));

    await until(async () => (await reports(name, "Daily digest")).length > 0, "the report");
    await settle();
    expect(await reports(name, "Daily digest")).toEqual(['[automation "Daily digest" result: tell the user] echo: digest the news']);
    expect(await listed(name, id)).toMatch(/last run: done: .*echo: digest the news/);
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

  it("refuses a model that is not offered and runs a model-less automation on the subagents slot", async () => {
    const name = crypto.randomUUID();
    const refused = await say(name, automation({ action: "create", title: "Daily digest", prompt: "digest", cron: "0 9 * * *", model: "faux/missing" }));
    expect(refused).toMatch(/^tool said: faux\/missing is not available\. Choose one of: faux\/faux \(.*\); faux\/faux-text \(off\)\.$/);
    expect(await say(name, automation({ action: "list", all: true }))).toBe("tool said: No automations.");

    // The user moves the subagents slot to faux-text in Settings.
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.frames.some((frame) => frame.type === "settings"));
    socket.send(JSON.stringify({ type: "set-model", id: "slot", slot: "subagents", setting: { provider: "faux", modelId: "faux-text", thinkingLevel: "off" } }));
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === "slot"));
    socket.close();

    const id = await create(name);
    expect(await listed(name, id)).toContain("model: subagents slot");
    await runNow(name, id);
    await runEnds(name, id);
    const calls = await runCalls(name, id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((call) => call.model)).toEqual(calls.map(() => "faux-text"));
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
    expect(await booking(name, id)).toMatchObject({ type: "cron", cron: "0 9 * * *" });
    expect(await runs(name, id)).toHaveLength(1);
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
    expect(after).toMatchObject({ type: "cron", cron: "30 14 * * *" });
    expect(await inside(name, (instance) => instance.automations.scheduler.get(before!.id))).toBeUndefined();

    // A cron the Scheduler cannot read is refused, and the booking stays as it was.
    expect(await say(name, automation({ action: "update", id, cron: "not a cron" }))).toMatch(/^tool said: Cannot schedule "not a cron": /);
    expect(await listed(name, id)).toContain(`next: ${nextDaily(14, 30)}`);
    expect(await booking(name, id)).toMatchObject({ type: "cron", cron: "30 14 * * *" });
  });

  it("archive cancels the schedule; unarchive brings it back paused", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);

    expect(await say(name, automation({ action: "archive", id }))).toBe('tool said: Archived "Daily digest".');
    expect(await booking(name, id)).toBeUndefined();
    expect(await inside(name, (instance) => instance.automations.scheduler.list())).toEqual([]);
    expect(await listed(name, id)).toContain("[archived]");
    expect(await say(name, automation({ action: "list" }))).toBe("tool said: No automations.");

    expect(await say(name, automation({ action: "unarchive", id }))).toBe('tool said: Unarchived "Daily digest"; it is paused.');
    expect(await listed(name, id)).toContain("[paused]");
    expect(await listed(name, id)).toContain("next: none");
    expect(await booking(name, id)).toBeUndefined();

    expect(await say(name, automation({ action: "resume", id }))).toBe('tool said: Resumed "Daily digest".');
    expect(await listed(name, id)).toContain(`next: ${nextDaily(9)}`);
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
    expect(await booking(name, id)).toMatchObject({ type: "cron", cron: "0 9 * * *" });
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

    mac.send({ type: "result", task: run!.id, turn: 1, ok: true, text: "backups are fine", session: "s-backups" });
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
    await inside(name, (instance) => instance.machines.configure("mac", { state: "paused" }));

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

  it("reports to the side chat that made it, unarchiving it if needed", async () => {
    const name = crypto.randomUUID();
    const chat = await inside(name, (instance) => instance.newChat());
    const id = await create(name, {}, chat);
    expect(await listed(name, id)).toContain(`reports to: untitled (${chat})`);

    await inside(name, (instance) => instance.chats.archive(chat, true));
    const archived = () => inside(name, (instance) => instance.chats.list().find((row) => row.session === chat)?.archived_at ?? null);
    expect(await archived()).not.toBeNull();

    await runNow(name, id);
    await runEnds(name, id);
    await until(async () => (await reports(name, "Daily digest", chat)).length > 0, "the side chat's report");
    expect(await archived()).toBeNull();
    expect(await reports(name, "Daily digest")).toEqual([]);

    // Sent to main instead, the next run reports there.
    expect(await say(name, automation({ action: "update", id, chat: "main" }))).toBe('tool said: Updated "Daily digest".');
    expect(await listed(name, id)).toContain("reports to: main");
    await pause(1_100);
    await runNow(name, id);
    await until(async () => (await reports(name, "Daily digest", ROOT_SESSION)).length > 0, "the main chat's report");
    expect(await reports(name, "Daily digest", chat)).toHaveLength(1);
    expect(await runs(name, id)).toHaveLength(2);
  });
});
