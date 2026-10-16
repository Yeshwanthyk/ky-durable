import type { JsonValue } from "@earendil-works/pi-ai";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../automations/contract";
import type { ProactivityLevel as Level } from "../dreaming/contract";
import { agent, connectExecutor, gateStarted, inside, prompt, snapshotView, submit, until } from "./drive";

/**
 * How an automation's report reaches the user (src/automations/delivery.ts), on ky's real PiAgent and the fake
 * Workers AI: into an idle chat at once, into a busy one only when its turn is over, and into today's brief when
 * Settings › Proactivity is at boundary and the user is away. Also the gate's repeat check: a gate that finds what
 * the last fire found skips the fire without a model call.
 */

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const automation = (args: Record<string, JsonValue>) => `tool automation ${JSON.stringify(args)}`;

async function say(name: string, text: string): Promise<string> {
  return inside(name, async (instance) => (await instance.harness.prompt(text)).text ?? "");
}

/** Ask for an automation; its id. */
async function create(name: string, args: Record<string, JsonValue> = {}): Promise<string> {
  const said = await say(name, automation({ action: "create", title: "Daily digest", prompt: "digest the news", cron: "0 9 * * *", ...args }));
  const id = /Created automation (\w+),/.exec(said)?.[1];

  if (!id) throw new Error(`Not created: ${said}`);

  return id;
}

/** Run it now as the user asks, without going through the chat, which may be busy. */
async function runNow(name: string, id: string): Promise<void> {
  await inside(name, (instance) => instance.automations.run(id));
  await runDurableObjectAlarm(agent(name));
}

function runs(name: string, id: string): Promise<TaskRow[]> {
  return inside(name, (instance) => instance.feed.list().filter((task) => task.source === `automation:${id}`));
}

async function runEnds(name: string, id: string): Promise<void> {
  await until(async () => (await runs(name, id)).some((task) => task.status === "done"), `a run of ${id} to end`);
}

/** The main chat's messages as [role, text] pairs, oldest first. */
async function transcript(name: string): Promise<Array<[string, string]>> {
  const view = await snapshotView(name);

  return view.messages.map((message) => [message.role, message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")]);
}

/** The user messages of the main chat that start with `start`. */
async function told(name: string, start: string): Promise<string[]> {
  return (await transcript(name)).filter(([role, text]) => role === "user" && text.startsWith(start)).map(([, text]) => text);
}

const REPORT = '[automation "Daily digest" result';

const reports = (name: string) => told(name, REPORT);

type Row = { id: string; session: string; state: string; line: string };

function deliveries(name: string): Promise<Row[]> {
  return inside(name, (_instance, state) => state.storage.sql.exec<Row>("SELECT id, session, state, line FROM ky_deliveries ORDER BY created_at").toArray());
}

/** Set the proactivity level, and when the user last sent a message: `away` is two hours ago, `here` is now. */
async function setUp(name: string, level: Level, presence: "away" | "here"): Promise<void> {
  await inside(name, (instance) => {
    instance.proactivity.set(level);
    instance.presence.seen(presence === "here" ? Date.now() : Date.now() - 2 * 3_600_000);
  });
}

describe("delivering an automation's report", () => {
  it("waits for a busy chat's turn to end, and never enters the run", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);
    await submit(name, "gate");
    await gateStarted(name, 1);

    await runNow(name, id);
    await runEnds(name, id);
    await until(async () => (await deliveries(name)).some((row) => row.state === "queued"), "the queued report");
    // A steer would have landed after the run's first tool round; the gate holds the run in that round.
    await pause(400);
    expect(await reports(name)).toEqual([]);

    await agent(name).release();
    await until(async () => (await reports(name)).length > 0, "the report");
    const said = await transcript(name);
    const answer = said.findIndex(([role, text]) => role === "assistant" && text.includes("released after 1 runs"));
    const report = said.findIndex(([role, text]) => role === "user" && text.startsWith(REPORT));
    expect(answer).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(answer);
    expect(await reports(name)).toHaveLength(1);
    expect((await deliveries(name)).map((row) => row.state)).toEqual(["chat"]);
  });

  it("goes into an idle chat at once, which counts as an event ky surfaced", async () => {
    const name = crypto.randomUUID();
    await setUp(name, "boundary", "here");
    const id = await create(name);

    await runNow(name, id);
    await until(async () => (await reports(name)).length > 0, "the report");
    expect((await reports(name))[0]).toContain("echo: digest the news");

    const [row] = await deliveries(name);
    expect(row).toMatchObject({ session: ROOT_SESSION, state: "chat" });
    expect(row!.line).toMatch(/^automation "Daily digest": echo: digest the news/);

    const surfaced = await inside(name, (_instance, state) => state.storage.sql.exec<{ ref: string }>("SELECT kind, loop, ref, item, outcome FROM ky_surfaced").toArray());
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toMatchObject({ kind: "event", loop: "event", item: row!.id, outcome: null });
    expect(surfaced[0]!.ref).toMatch(/^task:/);
  });

  it("goes to today's brief for a user who is away at boundary, and moves the chat up", async () => {
    const name = crypto.randomUUID();
    const id = await create(name);
    await setUp(name, "boundary", "away");
    const before = await inside(name, (instance) => instance.chats.mainUpdatedAt());
    await pause(5);

    await runNow(name, id);
    await until(async () => (await deliveries(name)).length > 0, "the delivery");
    expect((await deliveries(name)).map((row) => row.state)).toEqual(["brief"]);
    expect(await inside(name, (instance) => instance.chats.mainUpdatedAt())).toBeGreaterThan(before);

    const card = await inside(name, (instance) => instance.brief.view());
    expect(card?.lines).toHaveLength(1);
    expect(card?.lines[0]?.text).toMatch(/^automation "Daily digest": echo: digest the news/);
    expect(card?.lines[0]?.chip).toContain(REPORT);

    // Nor does the chat get it later.
    await pause(400);
    expect(await reports(name)).toEqual([]);
  });

  it("goes to the chat at off and at brief even when the user is away, and when the brief is full", async () => {
    for (const level of ["off", "brief"] as const) {
      const name = crypto.randomUUID();
      const id = await create(name);
      await setUp(name, level, "away");

      await runNow(name, id);
      await until(async () => (await reports(name)).length > 0, `the report at ${level}`);
      expect((await deliveries(name)).map((row) => row.state)).toEqual(["chat"]);
    }

    const name = crypto.randomUUID();
    const id = await create(name);
    await setUp(name, "boundary", "away");
    await inside(name, (instance) => {
      for (const n of [1, 2, 3]) instance.brief.append({ text: `Line ${n}` }, { loop: "event", ref: `test:${n}` });
    });

    await runNow(name, id);
    await until(async () => (await reports(name)).length > 0, "the report past a full brief");
    expect((await deliveries(name)).map((row) => row.state)).toEqual(["chat"]);
  });

  it("keeps a queued report through a restart and delivers it once", async () => {
    const name = crypto.randomUUID();
    const item = { id: "test-report-1", session: ROOT_SESSION, content: "[test report] the trip form is due Friday", line: "Trip form due Friday", ref: "test:1" };
    await prompt(name, "hello");

    // What a busy chat leaves: the row, queued (the first test makes it so). The test cannot evict the object while
    // a gate holds a run, so it writes that row itself and evicts the idle object.
    await inside(name, (_instance, state) =>
      state.storage.sql.exec(
        "INSERT INTO ky_deliveries (id, session, content, line, ref, state, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
        item.id,
        item.session,
        item.content,
        item.line,
        item.ref,
        Date.now()
      )
    );
    expect(await told(name, "[test report]")).toEqual([]);
    await evictDurableObject(agent(name));

    // Any call starts the object again, and its start delivers what waits.
    await until(async () => (await told(name, "[test report]")).length > 0, "the report after the restart");
    // Handed over again, and started again: still once.
    await inside(name, (instance) => instance.deliveries.deliver(item));
    await evictDurableObject(agent(name));
    await inside(name, (instance) => instance.deliveries.recover());
    await pause(400);
    expect(await told(name, "[test report]")).toEqual([item.content]);
    expect((await deliveries(name)).map((row) => row.state)).toEqual(["chat"]);
  });
});

describe("a gate that finds what it found last fire", () => {
  /** A scheduled fire now, which its gate decides. */
  async function fire(name: string, id: string): Promise<void> {
    await inside(name, (instance) => instance.automations.scheduler.set(new Date(), "automation", { id }));
    await runDurableObjectAlarm(agent(name));
  }

  const runCalls = (name: string, id: string) =>
    inside(name, (instance) => instance.boundary.calls.filter((call) => call.system.includes(`automation-${id}`)).length);

  it("skips the fire without a model call, and says so in its list", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const id = await create(name, { title: "School mail", prompt: "tell me what school sent", cron: "*/15 * * * *", gate: 'answer ["Trip form due Friday"]' });

    await fire(name, id);
    await runEnds(name, id);
    const calls = await runCalls(name, id);
    expect(calls).toBeGreaterThan(0);

    // Fires a second apart are separate slots.
    await pause(1_100);
    await fire(name, id);
    await pause(400);
    expect(await runs(name, id)).toHaveLength(1);
    expect(await runCalls(name, id)).toBe(calls);
    expect(await say(name, automation({ action: "list" }))).toContain("same: found what the last fire found, so this one did not run");

    // Something new runs again.
    await say(name, automation({ action: "update", id, gate: 'answer ["Trip form due Friday", "Pizza day"]' }));
    await pause(1_100);
    await fire(name, id);
    await until(async () => (await runs(name, id)).length === 2, "the run on something new");
  });
});
