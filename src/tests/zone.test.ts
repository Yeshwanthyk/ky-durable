import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dreamCron } from "../dreaming/wiring";
import { agent, browser, call, inside } from "./drive";

/**
 * The user's time zone (src/automations/automations.ts): followed from where each browser connects
 * (Cloudflare's `cf.timezone`) until the user pins one in Settings › Proactivity, and again once they pick Automatic.
 */

/** Open the agent `name` as a browser Cloudflare places in `zone`. */
async function connectFrom(name: string, zone: string): Promise<void> {
  const response = await call(`/agents/pi-agent/${name}`, { headers: { Upgrade: "websocket" }, cf: { timezone: zone } });
  expect(response.status).toBe(101);
  response.webSocket?.accept();
  response.webSocket?.close();
}

const checkIns = (name: string) => inside(name, (instance) => instance.automations.checkIns());

/** The nightly dream's cron, as booked. */
const dreamBooked = (name: string) =>
  inside(name, async (instance) => (await instance.automations.scheduler.list()).flatMap((schedule) => (schedule.callback === "dream" && schedule.type === "cron" ? [schedule.cron] : [])));

describe("the user's time zone", () => {
  it("follows where the browser connects until the user pins one, which rebooks the dream and survives a restart", async () => {
    const name = crypto.randomUUID();
    await connectFrom(name, "America/Los_Angeles");
    expect(await checkIns(name)).toMatchObject({ zone: "America/Los_Angeles", pinned: false });

    const page = await browser(name);
    expect(await page.send({ type: "zone" })).toMatchObject({ type: "result", result: { zone: "America/Los_Angeles", pinned: false } });
    expect(await page.send({ type: "set-zone", zone: "Pacific/Kiritimati" })).toMatchObject({
      type: "result",
      result: { zone: "Pacific/Kiritimati", pinned: true }
    });
    expect(await dreamBooked(name)).toEqual([dreamCron("Pacific/Kiritimati")]);

    await evictDurableObject(agent(name));
    await connectFrom(name, "Asia/Tokyo");
    expect(await checkIns(name)).toMatchObject({ zone: "Pacific/Kiritimati", pinned: true });
    expect(await dreamBooked(name)).toEqual([dreamCron("Pacific/Kiritimati")]);
    page.close();
  });

  it("follows the browser again once the user picks Automatic", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    await page.send({ type: "set-zone", zone: "Pacific/Kiritimati" });

    expect(await page.send({ type: "set-zone", zone: null })).toMatchObject({ type: "result", result: { zone: "Pacific/Kiritimati", pinned: false } });
    await connectFrom(name, "America/St_Johns");
    expect(await checkIns(name)).toMatchObject({ zone: "America/St_Johns", pinned: false });
    expect(await dreamBooked(name)).toEqual([dreamCron("America/St_Johns")]);
    page.close();
  });

  it("refuses a zone that isn't one, changing nothing", async () => {
    const name = crypto.randomUUID();
    await connectFrom(name, "Europe/Berlin");
    const page = await browser(name);

    expect(await page.send({ type: "set-zone", zone: "Mars/Olympus_Mons" })).toMatchObject({ type: "error" });
    expect(await checkIns(name)).toMatchObject({ zone: "Europe/Berlin", pinned: false });
    expect(await dreamBooked(name)).toEqual([dreamCron("Europe/Berlin")]);
    page.close();
  });

  it("an older table without the pin gains it, unpinned, keeping its zone", async () => {
    const name = crypto.randomUUID();
    await inside(name, (_, state) => {
      state.storage.sql.exec("DROP TABLE ky_check_ins");
      state.storage.sql.exec("CREATE TABLE ky_check_ins (id INTEGER PRIMARY KEY CHECK (id = 1), off INTEGER NOT NULL, zone TEXT)");
      state.storage.sql.exec("INSERT INTO ky_check_ins (id, off, zone) VALUES (1, 0, 'Europe/Lisbon')");
    });

    await evictDurableObject(agent(name));
    expect(await checkIns(name)).toEqual({ on: true, zone: "Europe/Lisbon", pinned: false });
  });
});
