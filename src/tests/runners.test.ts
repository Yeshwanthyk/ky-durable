import { env } from "cloudflare:workers";
import { evictDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decodeObjectFrame, PROTOCOL, REVOKED, type RunCommand } from "../runner-protocol";
import type { Vault as TestVault } from "./stack";
import { call, connect, connectRunner, FACTS, inside, machineToken, pair, pairing, pairingCode, prompt, runner, said, TOKEN, until } from "./drive";

/**
 * Runners' own tokens (src/runners.ts): pairing a machine with a code, its
 * machine token for the socket, removing it, and the task tokens its runs
 * carry. Pairing and removing go to the one agent "me", so each test names
 * its own machines.
 */

const vault = () => env.Vault.getByName("owner");

// SAFETY: src/tests/wrangler.jsonc binds Vault to the test stack's subclass.
const testVault = () => (env.Vault as DurableObjectNamespace<TestVault>).getByName("owner");

const named = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

const HELLO = JSON.stringify({ type: "hello", protocol: PROTOCOL, version: "test", active: [], facts: FACTS });

type Heard = { socket: WebSocket; frames: unknown[]; closed: Promise<number> };

/** What the object says on a runner socket, and the code it closes with. */
function hear(socket: WebSocket): Heard {
  const frames: unknown[] = [];
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  socket.addEventListener("message", (event) => {
    const frame = decodeObjectFrame(String(event.data));

    if (frame !== undefined) frames.push(frame);
  });

  return { socket, frames, closed };
}

/** A runner socket through the Worker, as `machine` with `token`, that has said hello. */
async function dial(machine: string, token: string): Promise<Heard> {
  const response = await call(`/runner/${machine}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const heard = hear(socket);
  socket.send(HELLO);
  await until(() => inside("me", (instance) => instance.machines.online(machine)), `${machine} online`);

  return heard;
}

/** Whether the agent "me" lists the machine. */
const listed = (machine: string) => inside("me", (instance) => instance.machines.machines().some((row) => row.name === machine));

/** The socket was told its pairing is over, and closed with REVOKED. */
async function turnedAway({ frames, closed }: Heard): Promise<void> {
  expect(await closed).toBe(REVOKED);
  expect(frames).toContainEqual({ type: "goodbye", reason: "This machine is not paired with ky; pair it again." });
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
    expect(await listed(machine)).toBe(false);
    expect(await inside("me", (instance) => instance.feed.open("machine", machine))).toEqual([]);
    await said("me", `${machine} was removed from ky.`);

    expect((await call(`/api/runners/${machine}`, { method: "DELETE" })).status).toBe(404);
  });

  it("turns away a socket whose token the Worker took just before the remove, and keeps no machine", async () => {
    const machine = named("late");
    await machineToken(machine);
    const before = await pairing("me", machine);

    // The Worker checked the token, then the remove landed, then the socket reaches the agent.
    expect((await call(`/api/runners/${machine}`, { method: "DELETE" })).status).toBe(204);
    await turnedAway(hear(await connectRunner("me", machine, before)));
    expect(await listed(machine)).toBe(false);
  });

  it("turns away a hello that comes after the remove on a socket taken before it, and keeps no machine", async () => {
    const machine = named("between");
    await machineToken(machine);
    const heard = hear(await connectRunner("me", machine));

    // Removed after the socket was taken, with nothing closing it: only its hello is left to refuse.
    await inside("me", (instance) => instance.machines.remove(machine));
    heard.socket.send(HELLO);
    await turnedAway(heard);
    expect(await listed(machine)).toBe(false);
  });

  it("turns away the last pairing's socket once the machine pairs again, and takes the new one", async () => {
    const machine = named("again");
    const old = await machineToken(machine);
    const before = await pairing("me", machine);
    const token = await machineToken(machine);

    expect((await call(`/runner/${machine}`, { headers: { Authorization: `Bearer ${old}` } })).status).toBe(401);
    await turnedAway(hear(await connectRunner("me", machine, before)));

    const { socket } = await dial(machine, token);
    socket.close();
  });
});

describe("pairing one name twice at the same moment", () => {
  it("leaves only the winning pairing's token working", async () => {
    const machine = named("race");
    const codes = await Promise.all([pairingCode(), pairingCode()]);
    // Both pairings are mid-mint at once, so each reaches the agent while the other is under way.
    await testVault().slowMachineMints(2, 100);
    const responses = await Promise.all(codes.map(({ code }) => pair({ code, name: machine, facts: FACTS })));
    const tokens = await Promise.all(responses.map((response) => response.json<{ token: string }>().then((body) => body.token)));

    // A plain GET passes the token check, then asks for the upgrade.
    const statuses = await Promise.all(
      tokens.map(async (token) => (await call(`/runner/${machine}`, { headers: { Authorization: `Bearer ${token}` } })).status)
    );

    expect(statuses.toSorted()).toEqual([401, 426]);
    const winner = tokens[statuses.indexOf(426)]!;
    expect((await vault().check("machine", winner))?.split(":")[1]).toBe(await pairing("me", machine));
  });
});

describe("a machine token from before pairings had ids", () => {
  it("is gone once the Vault starts", async () => {
    const machine = named("legacy");
    const legacy = await vault().mint("machine", machine);
    expect(await vault().check("machine", legacy)).toBe(machine);

    await evictDurableObject(vault());
    expect(await vault().check("machine", legacy)).toBeNull();
  });
});

describe("the methods of the runner routes", () => {
  it("answers 405 to anything but POST on the codes path, and never takes it for a machine", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      expect((await call("/api/runners/codes", { method })).status, method).toBe(405);
    }
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

  it("are revoked when the agent starts, for a task that ended and whose revoke was lost", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);
    await prompt(name, "machine build it");
    const run = await mac.run();
    mac.send({ type: "result", task: run.task, turn: run.turn, ok: true, text: "built", session: null, agent: "claude" });
    await until(async () => (await vault().check("task", run.taskToken)) === null, "the token stopped with the task");
    mac.socket.close();

    // The revoke as if lost: the ended task has a live token again.
    const lost = await vault().issue("task", run.task);
    expect(await vault().check("task", lost)).toBe(run.task);

    await evictDurableObject(env.PiAgent.getByName(name));
    // A page opening the agent starts it.
    (await connect(name)).close();
    await until(async () => (await vault().check("task", lost)) === null, "the start revoked the lost token");
  });

  it("survive the start's sweep while a follow-up runs after a stop, though the task shows as ended", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);
    await prompt(name, "machine build it");
    const run = await mac.run();
    mac.send({ type: "session", task: run.task, turn: run.turn, session: "s-stop" });

    // Stop, and a follow-up before the runner says the stopped turn ended.
    await prompt(name, `tool machine {"action":"stop","task":"${run.task}"}`);
    expect(await mac.next()).toMatchObject({ type: "stop", task: run.task });
    await prompt(name, `tool machine {"action":"send","task":"${run.task}","message":"then do this"}`);
    const followUp = await mac.run();
    expect(followUp.taskToken).toBe(run.taskToken);
    mac.send({ type: "result", task: run.task, turn: run.turn, ok: false, text: "stopped", session: "s-stop", agent: "claude" });
    await until(
      () => inside(name, (instance) => instance.feed.get(run.task)?.status === "stopped"),
      "the stopped turn ended the task's status"
    );

    // The follow-up's process holds the token; the agent restarts mid-turn.
    await evictDurableObject(env.PiAgent.getByName(name));
    (await connect(name)).close();
    await inside(name, (instance) => instance.machines.sweepTokens());
    expect(await vault().check("task", run.taskToken)).toBe(run.task);
    mac.socket.close();
  });

  it("survive the start's sweep for an open task", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);
    await prompt(name, "machine keep at it");
    const run = await mac.run();
    mac.socket.close();

    await evictDurableObject(env.PiAgent.getByName(name));
    (await connect(name)).close();
    await inside(name, (instance) => instance.machines.sweepTokens());
    expect(await vault().check("task", run.taskToken)).toBe(run.task);
  });

  it("deliver a run again, a moment later, after the Vault failed to issue its token", async () => {
    const mac = await runner("me");
    expect((await call("/test/vault-fail-issues?count=1", { method: "POST" })).status).toBe(204);

    await prompt("me", "machine retry the delivery");
    const run = await mac.run();
    expect(await vault().check("task", run.taskToken)).toBe(run.task);

    mac.send({ type: "result", task: run.task, turn: run.turn, ok: true, text: "done", session: null, agent: "claude" });
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
