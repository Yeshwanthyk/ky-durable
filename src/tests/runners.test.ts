import { env } from "cloudflare:workers";
import { evictDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decodeObjectFrame, PROTOCOL, REVOKED, type RunCommand } from "../runner-protocol";
import { call, FACTS, inside, machineToken, pair, pairingCode, prompt, runner, said, TOKEN, until } from "./drive";

/**
 * Runners' own tokens (src/runners.ts): pairing a machine with a code, its
 * machine token for the socket, removing it, and the task tokens its runs
 * carry. Pairing and removing go to the one agent "me", so each test names
 * its own machines.
 */

const vault = () => env.Vault.getByName("owner");

const named = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

/** A runner socket through the Worker, as `machine` with `token`, that has said hello. */
async function dial(machine: string, token: string): Promise<{ socket: WebSocket; frames: unknown[]; closed: Promise<number> }> {
  const response = await call(`/runner/${machine}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const frames: unknown[] = [];
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  socket.addEventListener("message", (event) => {
    const frame = decodeObjectFrame(String(event.data));

    if (frame !== undefined) frames.push(frame);
  });
  socket.accept();
  socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, version: "test", active: [], facts: FACTS }));
  await until(() => inside("me", (instance) => instance.machines.online(machine)), `${machine} online`);

  return { socket, frames, closed };
}

describe("pairing a machine", () => {
  it("lists the machine with what it said, and its token opens its socket", async () => {
    const machine = named("paired");
    const { code, expiresAt } = await pairingCode();
    expect(expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);

    const response = await pair({ code, name: machine, facts: { ...FACTS, chrome: true } });
    expect(response.status).toBe(200);
    const { machine: paired, token } = await response.json<{ machine: string; token: string }>();
    expect(paired).toBe(machine);

    const listed = await inside("me", (instance) => instance.machines.machines().find((row) => row.name === machine));
    expect(listed).toMatchObject({ name: machine, facts: { chrome: true } });

    const { socket } = await dial(machine, token);
    socket.close();
  });

  it("takes a code once, even from two runners at the same moment", async () => {
    const { code } = await pairingCode();

    const [first, second] = await Promise.all([
      pair({ code, name: named("racer"), facts: FACTS }),
      pair({ code, name: named("racer"), facts: FACTS })
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 401]);

    const again = await pair({ code, name: named("late"), facts: FACTS });
    expect(again.status).toBe(401);
    expect(await again.text()).toContain("wrong, used or expired");
  });

  it("refuses a code after its ten minutes", async () => {
    const { code } = await pairingCode();
    await call(`/test/vault-clock?ahead=${10 * 60_000 + 1}`, { method: "POST" });

    try {
      expect((await pair({ code, name: named("slow"), facts: FACTS })).status).toBe(401);
    } finally {
      await call("/test/vault-clock?ahead=0", { method: "POST" });
    }
  });

  it("refuses a bad name or facts without spending the code, and floods from one address", async () => {
    const { code } = await pairingCode();
    expect((await pair({ code, name: "Not A Name", facts: FACTS })).status).toBe(400);
    expect((await pair({ code, name: named("odd"), facts: { os: "darwin" } })).status).toBe(400);
    expect((await pair({ code, name: named("ok"), facts: FACTS })).status).toBe(200);

    const from = crypto.randomUUID();
    const statuses: number[] = [];

    for (let i = 0; i < 11; i++) statuses.push((await pair({ code: "nope", name: "flood", facts: FACTS }, from)).status);

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
  });

  it("makes codes and removes machines only for the signed-in user", async () => {
    expect((await call("/api/runners/codes", { method: "POST", headers: { Authorization: "" } })).status).toBe(401);
    expect((await call("/api/runners/mac", { method: "DELETE", headers: { Authorization: "" } })).status).toBe(401);
    const machine = named("owned");
    const token = await machineToken(machine);
    // A machine's own token is not the user's.
    expect((await call("/api/runners/codes", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await call(`/api/runners/${machine}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
});

describe("removing a machine", () => {
  it("says goodbye and closes its socket with REVOKED, ends its tasks, and refuses its token", async () => {
    const machine = named("gone");
    const token = await machineToken(machine);
    const { frames, closed } = await dial(machine, token);

    await prompt("me", `machine@${machine} watch the logs`);
    // SAFETY: frames holds only what decodeObjectFrame returned, each an object.
    await until(async () => frames.some((frame) => (frame as { type?: string }).type === "run"), "the run reached the runner");

    expect((await call(`/api/runners/${machine}`, { method: "DELETE" })).status).toBe(204);
    expect(await closed).toBe(REVOKED);
    expect(frames).toContainEqual(expect.objectContaining({ type: "goodbye", reason: `${machine} was removed from ky; pair it again to use it.` }));

    const runner = await call(`/runner/${machine}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } });
    expect(runner.status).toBe(401);
    expect(await inside("me", (instance) => instance.machines.machines().some((row) => row.name === machine))).toBe(false);
    expect(await inside("me", (instance) => instance.feed.open("machine", machine))).toEqual([]);
    await said("me", `${machine} was removed from ky.`);

    expect((await call(`/api/runners/${machine}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("task tokens", () => {
  it("are the task's alone, last through a follow-up, and stop when the task ends", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);
    await prompt(name, "machine build it");
    const run = await mac.run();
    expect(await vault().check("task", run.taskToken)).toBe(run.task);
    // The user's sign-in is not a task token.
    expect(await vault().check("task", TOKEN)).toBeNull();

    mac.send({ type: "session", task: run.task, turn: run.turn, session: "s-token" });
    await prompt(name, `tool machine {"action":"send","task":"${run.task}","message":"also test it"}`);
    const steer = await mac.run();
    expect(steer.taskToken).toBe(run.taskToken);

    mac.send({ type: "result", task: run.task, turn: steer.turn, ok: true, text: "built", session: "s-token", agent: "claude" });
    await until(async () => (await vault().check("task", run.taskToken)) === null, "the token stopped with the task");

    await prompt(name, `tool machine {"action":"send","task":"${run.task}","message":"one more thing"}`);
    const followUp = await mac.run();
    expect(followUp.taskToken).not.toBe(run.taskToken);
    expect(await vault().check("task", followUp.taskToken)).toBe(run.task);
    mac.socket.close();
  });

  it("refuse an upload with another task's token after the first ends", async () => {
    const mac = await runner("me");
    await prompt("me", "machine screenshot one");
    const first = await mac.run();
    await prompt("me", "machine screenshot two");
    const second = await mac.run();

    const upload = (task: string, token: string) =>
      SELF.fetch(`https://ky.test/api/files?task=${task}`, {
        method: "PUT",
        body: new Uint8Array([137, 80, 78, 71]),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png", "Content-Length": "4", "X-Ky-Name": "shot.png" }
      });

    expect((await upload(first.task, second.taskToken)).status).toBe(401);
    expect((await upload(first.task, first.taskToken)).status).toBe(200);

    mac.send({ type: "result", task: first.task, turn: first.turn, ok: false, text: "gave up", session: null, agent: "claude" });
    await until(async () => (await upload(first.task, first.taskToken)).status === 401, "the ended task's token is refused");
    expect((await upload(second.task, second.taskToken)).status).toBe(200);
    mac.socket.close();
  });

  it("are the same in a resend after the agent restarts, and never kept in the agent's storage", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);
    await prompt(name, "machine keep going");
    await until(async () => mac.commands.length > 0, "the run was sent");
    // SAFETY: until waited for a command, and a runner here is only ever sent runs.
    const sent = mac.commands.shift() as RunCommand;
    mac.socket.close();

    await evictDurableObject(env.PiAgent.getByName(name));
    const again = await runner(name);
    const resent = await again.run();
    expect(resent).toMatchObject({ task: sent.task, turn: sent.turn });
    expect(resent.taskToken).toBe(sent.taskToken);

    // Every table, and the key-value storage the SDKs keep in _cf_KV.
    const stored = await inside(name, async (_instance, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'")
        .toArray();

      const rows = tables.map(({ name: table }) => JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()));

      return [...rows, JSON.stringify([...(await state.storage.list()).entries()])].join("\n");
    });

    expect(stored).toContain(sent.task);
    expect(stored).not.toContain(sent.taskToken);
    again.socket.close();
  });
});
