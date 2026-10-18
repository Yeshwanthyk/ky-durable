import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dreamCron } from "../dreaming/wiring";
import type { PiClientMessage } from "../protocol";
import { agent, browser, call, follow, inside } from "./drive";

/**
 * The user's time zone (src/automations/automations.ts): followed from where each browser connects
 * (Cloudflare's `cf.timezone`) until the user pins one in Settings › Proactivity, and again once they pick Automatic.
 */

/** A page on the agent `name` from a browser Cloudflare places in `zone`: a way to send a message and get its frame. */
async function pageFrom(name: string, zone: string) {
  const response = await call(`/agents/pi-agent/${name}`, { headers: { Upgrade: "websocket" }, cf: { timezone: zone } });
  expect(response.status).toBe(101);
  const socket = response.webSocket;

  if (!socket) throw new Error("No socket");
  socket.accept();
  const client = follow(socket);

  const send = async (message: PiClientMessage) => {
    const id = crypto.randomUUID();
    socket.send(JSON.stringify({ ...message, id }));
    const answered = () => client.frames.find((frame) => (frame.type === "result" || frame.type === "error") && frame.id === id);
    await client.until(() => answered() !== undefined);

    return answered();
  };

  return { send, close: () => socket.close() };
}

/** Open the agent `name` as a browser Cloudflare places in `zone`, and leave. */
async function connectFrom(name: string, zone: string): Promise<void> {
  (await pageFrom(name, zone)).close();
}

const checkIns = (name: string) => inside(name, (instance) => instance.automations.checkIns());

/** The nightly dream's cron, as booked. */
const dreamBooked = (name: string) =>
  inside(name, async (instance) => (await instance.automations.scheduler.list()).flatMap((schedule) => (schedule.callback === "dream" && schedule.type === "cron" ? [schedule.cron] : [])));

describe("the user's time zone", () => {
  it("follows where the browser connects until the user pins one, which rebooks the dream and survives a restart", async () => {
    const name = crypto.randomUUID();
    const page = await pageFrom(name, "America/Los_Angeles");
    expect(await checkIns(name)).toMatchObject({ zone: "America/Los_Angeles", pinned: false });

    expect(await page.send({ type: "zone" })).toMatchObject({ type: "result", result: { zone: "America/Los_Angeles", pinned: false, detected: "America/Los_Angeles" } });
    expect(await page.send({ type: "set-zone", zone: "pacific/kiritimati" })).toMatchObject({
      type: "result",
      result: { zone: "Pacific/Kiritimati", pinned: true, detected: "America/Los_Angeles" }
    });
    expect(await dreamBooked(name)).toEqual([dreamCron("Pacific/Kiritimati")]);
    page.close();

    await evictDurableObject(agent(name));
    await connectFrom(name, "Asia/Tokyo");
    expect(await checkIns(name)).toMatchObject({ zone: "Pacific/Kiritimati", pinned: true });
    expect(await dreamBooked(name)).toEqual([dreamCron("Pacific/Kiritimati")]);
  });

  it("picking Automatic follows the asking browser's zone at once, and later connects again", async () => {
    const name = crypto.randomUUID();
    const page = await pageFrom(name, "America/St_Johns");
    await page.send({ type: "set-zone", zone: "Pacific/Kiritimati" });

    expect(await page.send({ type: "set-zone", zone: null })).toMatchObject({ type: "result", result: { zone: "America/St_Johns", pinned: false } });
    expect(await dreamBooked(name)).toEqual([dreamCron("America/St_Johns")]);

    await connectFrom(name, "Asia/Kolkata");
    expect(await checkIns(name)).toMatchObject({ zone: "Asia/Kolkata", pinned: false });
    expect(await dreamBooked(name)).toEqual([dreamCron("Asia/Kolkata")]);
    page.close();
  });

  it("picking Automatic from a browser in no known zone unpins, keeping the zone until a connect places one", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    await page.send({ type: "set-zone", zone: "Pacific/Kiritimati" });

    expect(await page.send({ type: "set-zone", zone: null })).toMatchObject({ type: "result", result: { zone: "Pacific/Kiritimati", pinned: false, detected: null } });
    await connectFrom(name, "Europe/Lisbon");
    expect(await checkIns(name)).toMatchObject({ zone: "Europe/Lisbon", pinned: false });
    page.close();
  });

  it("refuses a zone that isn't an IANA name, or an offset, changing nothing", async () => {
    const name = crypto.randomUUID();
    const page = await pageFrom(name, "Europe/Berlin");

    expect(await page.send({ type: "set-zone", zone: "Mars/Olympus_Mons" })).toMatchObject({ type: "error" });
    expect(await page.send({ type: "set-zone", zone: "+05:30" })).toMatchObject({ type: "error" });
    expect(await checkIns(name)).toMatchObject({ zone: "Europe/Berlin", pinned: false });
    expect(await dreamBooked(name)).toEqual([dreamCron("Europe/Berlin")]);
    page.close();
  });

  it("a pin that lands while a connect books keeps its zone, and the dream is booked in it", async () => {
    const name = crypto.randomUUID();
    await connectFrom(name, "America/Los_Angeles");

    await inside(name, (instance) => Promise.all([instance.automations.setZone("Asia/Tokyo"), instance.automations.pinZone("Europe/Berlin")]));
    expect(await checkIns(name)).toMatchObject({ zone: "Europe/Berlin", pinned: true });
    expect(await dreamBooked(name)).toEqual([dreamCron("Europe/Berlin")]);
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
