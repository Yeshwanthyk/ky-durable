import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { localCron } from "../dreaming/contract";
import { browser, connectExecutor, fire, inside, type Tab, until } from "./drive";

/**
 * ky's looks over the day (src/dreaming/looks.ts) on its real Worker: booked at the user's look times while
 * Proactivity is on, and posting what a look decides in the main chat as ky's own message, as written. The fake
 * look answers with each `look> {row}` said in a chat (src/tests/stack.ts). What decide picks of any rows is
 * proved in test/invariants/looks.test.ts.
 */

/** The looks booked, each its time and cron, earliest first. */
const booked = (name: string) =>
  inside(name, async (instance) =>
    (await instance.automations.scheduler.list())
      .filter((schedule) => schedule.callback === "look")
      .map((schedule) => `${JSON.stringify(schedule.payload)} ${schedule.type === "cron" ? schedule.cron : schedule.type}`)
      .toSorted()
  );

/** What the looks are booked as in `zone` at `times`. */
const wanted = (times: readonly string[], zone: string | null) =>
  times.map((time) => `${JSON.stringify({ time })} ${localCron(Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), zone)}`).toSorted();

const bookedAs = async (name: string, times: readonly string[], zone: string | null) => {
  await until(async () => JSON.stringify(await booked(name)) === JSON.stringify(wanted(times, zone)), `looks booked at ${times.join(", ")}`);
};

/** Each text ky said in the main chat, oldest first. */
const kySaid = (page: Tab) =>
  page
    .view()
    .messages.filter((message) => message.role === "assistant")
    .map((message) => message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""));

const look = (row: Readonly<Record<string, string>>) => `look> ${JSON.stringify(row)}`;

describe("the looks' bookings", () => {
  it("are one a look time while Proactivity is on, booked again when the times, the zone or on and off change", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    const zone = await inside(name, (instance) => instance.automations.checkIns().zone);

    await bookedAs(name, ["08:00", "13:00", "18:00"], zone);

    expect(await page.send({ type: "set-looks", looks: ["21:00", "07:30", "07:30"] })).toMatchObject({ type: "result" });
    await bookedAs(name, ["07:30", "21:00"], zone);

    expect(await page.send({ type: "set-looks", looks: ["25:00"] })).toMatchObject({ type: "error" });
    expect(await page.send({ type: "set-looks", looks: ["06:00", "07:00", "08:00", "09:00", "10:00"] })).toMatchObject({ type: "error" });

    await inside(name, (instance) => instance.automations.setZone("Asia/Kolkata"));
    await bookedAs(name, ["07:30", "21:00"], "Asia/Kolkata");

    expect(await page.send({ type: "set-proactivity", level: "off" })).toMatchObject({ type: "result" });
    await bookedAs(name, [], "Asia/Kolkata");

    expect(await page.send({ type: "set-proactivity", level: "on" })).toMatchObject({ type: "result" });
    await bookedAs(name, ["07:30", "21:00"], "Asia/Kolkata");
    page.close();
  });
});

describe("a look", () => {
  it("posts what it decides in the main chat as written, starting no turn, records it, and says it once", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    await page.say('tool anticipate {"action":"add","kind":"open_loop","text":"Call the bank about the card"}');
    const [loop] = await inside(name, (instance) => instance.anticipations.open().map((row) => row.id));
    const ref = `anticipation:${loop}`;
    const said = "You still owe the bank a call about the card; they close at 17:00.";

    await page.say(
      [
        look({ ref, needed: "call the bank", current: "not called yet", action: "tell", message: said }),
        look({ ref: "memory:999", needed: "nothing", current: "nothing", action: "tell", message: "About a memory there is not." }),
        look({ ref, needed: "call the bank", current: "not called yet", action: "skip", message: "Skipped." })
      ].join(" ")
    );
    await page.until(() => !page.view().running);

    await inside(name, (instance) => instance.looks.run("08:00"));
    await page.until(() => kySaid(page).includes(said));

    // As written, last in the chat, with no answer to it: a post starts no turn.
    expect(kySaid(page).at(-1)).toBe(said);
    expect(kySaid(page).filter((text) => text === "About a memory there is not." || text === "Skipped.")).toEqual([]);
    expect(page.view().running).toBe(false);

    const [rows, looks] = await inside(name, (instance, state) => [
      state.storage.sql.exec<{ ref: string; item: string; text: string }>("SELECT ref, item, text FROM ky_surfaced WHERE kind = 'look'").toArray(),
      instance.feed.list().filter((task) => task.worker === "looks" && task.finished_at !== null).length
    ]);

    expect(rows).toMatchObject([{ ref, text: said }]);
    expect(rows[0]?.item).toMatch(new RegExp(`^look:\\d{4}-\\d{2}-\\d{2}:08:00:${ref}$`));
    expect(looks).toBe(1);

    // The next look weighs the same row: the user has not written since and its anticipation is still open, so it is
    // not said again.
    await inside(name, (instance) => instance.looks.run("13:00"));
    expect(kySaid(page).filter((text) => text === said)).toHaveLength(1);

    // The model reads the post as a notice in a user message, never as an assistant message of its own.
    await page.say("Thanks, calling now.");
    await page.until(() => !page.view().running);
    const asked = await inside(name, (instance) => instance.boundary.asked.find((users) => users.at(-1) === "Thanks, calling now."));
    expect(asked?.at(-2)).toBe(`[ky posted to the user, unasked] ${said}`);
    page.close();
  });

  it("takes none while Proactivity is off", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    expect(await page.send({ type: "set-proactivity", level: "off" })).toMatchObject({ type: "result" });

    await inside(name, (instance) => instance.looks.run("08:00"));
    expect(await inside(name, (instance) => instance.feed.list().filter((task) => task.worker === "looks"))).toEqual([]);
    page.close();
  });
});

describe("a look's watches", () => {
  it("are gated automations every 15 minutes, two a look and five at once, deleted when their anticipation closes or Proactivity goes off", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    await connectExecutor(name);

    for (const pr of [1, 2, 3, 4, 5, 6]) await page.say(`tool anticipate {"action":"add","kind":"watch","text":"CI on PR ${pr}"}`);
    await page.say('tool anticipate {"action":"add","kind":"open_loop","text":"Call the bank"}');
    const ids = await inside(name, (instance) => instance.anticipations.open().map((row) => row.id));
    const [first = 0, second = 0, ...rest] = ids;
    const gate = 'answer "pending"';
    const watchRow = (id: number, extra: Readonly<Record<string, string>>) => look({ ref: `anticipation:${id}`, needed: "CI", current: "pending", action: "skip", ...extra });

    // The first has no gate and the last is no watch: neither is watched. The rest are, two a look, five at most.
    await page.say(
      [
        watchRow(first, { prompt: "Say how CI went." }),
        ...[second, ...rest].map((id) => watchRow(id, { gate, prompt: `Say how CI on #${id} went.` }))
      ].join(" ")
    );
    await page.until(() => !page.view().running);

    const watches = () =>
      inside(name, (_instance, state) =>
        state.storage.sql
          .exec<{ watch: number; title: string; prompt: string; cron: string; chat: string; gate: string; created_by: string; status: string }>(
            "SELECT watch, title, prompt, cron, chat, gate, created_by, status FROM ky_automations WHERE watch IS NOT NULL ORDER BY watch"
          )
          .toArray()
      );

    await inside(name, (instance) => instance.looks.run("08:00"));
    expect(await watches()).toEqual(
      [second, rest[0]].map((id) => ({ watch: id, title: `Watch: CI on PR ${ids.indexOf(id ?? 0) + 1}`, prompt: `Say how CI on #${id} went.`, cron: "*/15 * * * *", chat: ROOT_SESSION, gate, created_by: "ky", status: "active" }))
    );

    await inside(name, (instance) => instance.looks.run("13:00"));
    expect((await watches()).map((row) => row.watch)).toEqual([second, ...rest.slice(0, 3)]);
    await inside(name, (instance) => instance.looks.run("18:00"));
    await inside(name, (instance) => instance.looks.run("19:00"));
    expect((await watches()).map((row) => row.watch)).toEqual([second, ...rest.slice(0, 4)]);

    // Closing the anticipation deletes its watch at once, not at the next look.
    await page.say(`tool anticipate {"action":"close","id":${second},"outcome":"dismissed"}`);
    await until(async () => !(await watches()).some((row) => row.watch === second), "the closed anticipation's watch deleted");
    expect((await watches()).map((row) => row.watch)).toEqual(rest.slice(0, 4));

    expect(await page.send({ type: "set-proactivity", level: "off" })).toMatchObject({ type: "result" });
    await until(async () => (await watches()).length === 0, "every watch deleted while Proactivity is off");
    page.close();
  });

  /** A chat with `count` watch anticipations, each asked to be watched (and told, if `tell`) by a look row with a gate; their ids. */
  const watching = async (count: number, { prompt = "Say how CI went.", tell = false } = {}) => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    await connectExecutor(name);

    for (let pr = 1; pr <= count; pr++) await page.say(`tool anticipate {"action":"add","kind":"watch","text":"CI on PR ${pr}"}`);
    const ids = await inside(name, (instance) => instance.anticipations.open().map((row) => row.id));
    await page.say(ids.map((id) => look({ ref: `anticipation:${id}`, needed: "CI", current: "pending", ...(tell ? { action: "tell", message: `CI on #${id} is pending.` } : { action: "skip" }), gate: 'answer "pending"', prompt })).join(" "));
    await page.until(() => !page.view().running);

    return { name, page, ids };
  };

  /** Each watch's automation id and anticipation, earliest anticipation first. */
  const watchIds = (name: string) =>
    inside(name, (_instance, state) => state.storage.sql.exec<{ id: string; watch: number }>("SELECT id, watch FROM ky_automations WHERE watch IS NOT NULL ORDER BY watch").toArray());

  it("are not booked, and nothing is posted, when Proactivity goes off while the look runs", async () => {
    const { name, page } = await watching(1, { tell: true });
    const before = kySaid(page).length;

    await inside(name, async (instance) => {
      const running = instance.looks.run("08:00");
      instance.proactivity.set("off");
      await running;
    });
    expect(await watchIds(name)).toEqual([]);
    expect(kySaid(page).length).toBe(before);
    page.close();
  });

  it("is not booked when its anticipation closes while its gate is checked", async () => {
    const { name, page, ids } = await watching(1);

    await inside(name, async (instance) => {
      const check = instance.automations.checkGate.bind(instance.automations);
      instance.automations.checkGate = async (code) => {
        const result = await check(code);
        instance.anticipations.close(ids[0] ?? 0, "done", "user");

        return result;
      };

      await instance.looks.run("08:00");
    });
    expect(await watchIds(name)).toEqual([]);
    page.close();
  });

  it("runs as a check-in: read only, with its report in the main chat", async () => {
    // The fake answers a check-in's run with what follows "What to look at:".
    const prompt = `What to look at:\ntool skill_manage ${JSON.stringify({ action: "create", name: "x", content: "y" })}`;
    const { name, page } = await watching(1, { prompt });
    await inside(name, (instance) => instance.looks.run("08:00"));
    const [watch] = await watchIds(name);

    await fire(name, watch?.id ?? "");
    await page.until(() => page.view().messages.some((message) => message.parts.some((part) => part.type === "text" && part.text.startsWith('[check-in "Watch: CI on PR 1"'))));
    const report = page.view().messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" && part.text.startsWith("[check-in") ? [part.text] : [])));
    expect(report[0]).toContain("Tool call blocked: A check-in may only call executor_skills, executor_execute, browse.");
    page.close();
  });

  it("deleted by the user dismisses its anticipation, so no look books it again", async () => {
    const { name, page, ids } = await watching(1);
    await inside(name, (instance) => instance.looks.run("08:00"));
    const [watch] = await watchIds(name);

    await page.say(`tool automation {"action":"delete","id":"${watch?.id}"}`);
    await until(async () => (await inside(name, (instance) => instance.anticipations.open().length)) === 0, "the anticipation dismissed");
    expect(await inside(name, (instance) => instance.anticipations.get(ids[0] ?? 0).status)).toBe("dismissed");
    await inside(name, (instance) => instance.looks.run("13:00"));
    expect(await watchIds(name)).toEqual([]);
    page.close();
  });

  it("count toward five only while active, though a paused one still holds its anticipation", async () => {
    const { name, page, ids } = await watching(6);

    for (const time of ["08:00", "13:00", "18:00"]) await inside(name, (instance) => instance.looks.run(time));
    const five = await watchIds(name);
    expect(five.map((row) => row.watch)).toEqual(ids.slice(0, 5));

    // Paused as from Activity, so the chat the fake look reads still ends with its rows.
    await inside(name, (instance) => instance.automations.pause(five[0]?.id ?? ""));
    await inside(name, (instance) => instance.looks.run("19:00"));
    expect((await watchIds(name)).map((row) => row.watch)).toEqual(ids);
    page.close();
  });
});

describe("a report delivered to a chat", () => {
  it("gets what ky knows recalled on its turn, as a message the user sends does", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    await page.say('tool memory_note {"text":"the user cycles to work every morning"}');

    await inside(name, (instance) =>
      instance.deliveries.deliver({ id: `report-${name}`, session: ROOT_SESSION, content: "Weather report: rain all morning, hard going for cycles", line: "Weather report", ref: "task:weather" })
    );
    await page.until(() => kySaid(page).some((text) => text.includes("Weather report")) && !page.view().running);

    const asked = await inside(name, (instance) => instance.boundary.asked.flatMap((users) => (users.at(-1)?.startsWith("Weather report") === true ? [users.at(-1)!] : [])));
    expect(asked.find((each) => each.includes("<recalled>"))).toContain("the user cycles to work every morning");
    page.close();
  });
});
