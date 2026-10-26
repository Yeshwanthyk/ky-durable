import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ASSERTION } from "../access";
import { CLOUD, CLOUD_FACTS } from "../cloud-facts";
import type { SandboxesView } from "../protocol";
import { SANDBOX_CAP, type Sandbox, type SandboxChange, type SandboxDraft, saveKey } from "../sandboxes";
import { agent, call, connect, FACTS, inside, pair, pairingCode, prompt, runner, tasks, until } from "./drive";
import { SUBSCRIPTION } from "../vault";
import { type CloudMachine, FakeBox, type Vault as TestVault } from "./stack";

/**
 * Sandboxes (src/sandboxes.ts, src/sandbox-routes.ts): the registry in the agent, where a task goes
 * for its repo, and Settings' routes that create, change and delete them, keeping a deleted one's
 * disk. The Worker's routes serve the one agent "me"; the rest runs in an agent of its own.
 */

const fresh = () => crypto.randomUUID();

/** A machine name no other test uses. */
const unique = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

/** One pkt-line of `text`, as git sends it. */
const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;

const json = (method: string, body: SandboxDraft | SandboxChange) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// SAFETY: src/tests/wrangler.jsonc binds CloudMachine to the test stack's subclass.
const machine = (id: string) => (env.CloudMachine as DurableObjectNamespace<CloudMachine>).getByName(id);

/** Run `work` in the sandbox `id`'s CloudMachine, its container the in-memory fake. */
const onBox = <T>(id: string, work: (instance: CloudMachine, box: FakeBox, state: DurableObjectState) => Promise<T> | T) =>
  runInDurableObject(machine(id), (instance: CloudMachine, state) => {
    instance.fake ??= new FakeBox();

    return work(instance, instance.fake, state);
  });

/** A sandbox made in Settings, on the agent "me", as the Worker's routes serve it. */
async function created(draft: SandboxDraft): Promise<Sandbox> {
  const answer = await call("/api/sandboxes", json("POST", draft));

  if (answer.status !== 201) throw new Error(`Not created: ${await answer.text()}`);

  return answer.json<Sandbox>();
}

/** A task for the machine `name` on "me": it wakes that machine, and stays open, as no runner takes it. */
const task = (name: string) => prompt("me", `tool machine ${JSON.stringify({ action: "run", prompt: "build it", machine: name })}`);

describe("the sandbox registry", () => {
  it("makes the cloud machine the first sandbox, the default, once, with its old save key", async () => {
    const name = fresh();

    expect(saveKey(CLOUD)).toBe("cloud-machine/save.tar.gz");
    expect(saveKey("sb-1234abcd")).toBe("cloud-machine/sb-1234abcd/save.tar.gz");

    const after = await inside(name, (instance) => {
      const first = instance.sandboxes.live();

      instance.sandboxes.migrate();

      return { first, again: instance.sandboxes.live() };
    });

    expect(after.first).toEqual([expect.objectContaining({ id: CLOUD, name: CLOUD, repos: [], isDefault: true, deletedAt: null })]);
    expect(after.again).toEqual(after.first);

    // Deleted, it stays a kept disk: the migration doesn't bring it back.
    const kept = await inside(name, (instance) => {
      instance.sandboxes.delete(CLOUD);
      instance.sandboxes.migrate();

      return { live: instance.sandboxes.live(), kept: instance.sandboxes.kept().map((each) => each.id) };
    });

    expect(kept).toEqual({ live: [], kept: [CLOUD] });
  });

  it("doesn't bring a deleted cloud back after a restart, though its kept disk had no save", async () => {
    const name = fresh();

    await inside(name, (instance) => instance.sandboxes.delete(CLOUD));
    // Its container, which other tests woke, is at rest: nothing runs, saves or waits there.
    await machine(CLOUD).reset(CLOUD);
    // The restart drops the kept disk, which has no save; the next start finds the registry empty.
    await evictDurableObject(agent(name));
    // The object starts when the browser opens it.
    const socket = await connect(name);
    await until(async () => (await inside(name, (instance) => instance.sandboxes.all())).length === 0, "the kept disk with no save dropped");
    socket.close();
    await evictDurableObject(agent(name));

    expect(await inside(name, (instance) => ({ all: instance.sandboxes.all(), machines: instance.machines.machines().map((each) => each.name) }))).toEqual({
      all: [],
      machines: []
    });
  });

  it("checks names, repos and the cap, and keeps a deleted one's row until it is forgotten", async () => {
    const result = await inside(fresh(), (instance) => {
      const sandboxes = instance.sandboxes;

      const refusal = (work: () => Sandbox) => {
        try {
          work();

          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };

      const web = sandboxes.create({ name: "web", repos: [" Me/Web ", "me/web"] }, () => false);

      const refusals = {
        badName: refusal(() => sandboxes.create({ name: "Web App" }, () => false)),
        takenByComputer: refusal(() => sandboxes.create({ name: "mac" }, (each) => each === "mac")),
        takenBySandbox: refusal(() => sandboxes.create({ name: "web" }, () => false)),
        badRepo: refusal(() => sandboxes.create({ name: "api", repos: ["api"] }, () => false)),
        ownedRepo: refusal(() => sandboxes.create({ name: "api", repos: ["me/web"] }, () => false)),
        idle: refusal(() => sandboxes.change(web.id, { idleMinutes: 0 })),
        stealRepo: refusal(() => sandboxes.change(CLOUD, { repos: ["ME/WEB"] }))
      };

      for (let i = sandboxes.live().length; i < SANDBOX_CAP; i++) sandboxes.create({ name: `box-${i}` }, () => false);
      const overCap = refusal(() => sandboxes.create({ name: "one-more" }, () => false));

      // The default moves; a deleted one is no default, owns nothing and frees its name.
      sandboxes.change(web.id, { isDefault: true, idleMinutes: 30 });
      const defaults = sandboxes.live().filter((each) => each.isDefault).map((each) => each.name);

      sandboxes.delete(web.id);

      const afterDelete = {
        owner: sandboxes.owner("me/web")?.name ?? null,
        reposFor: sandboxes.reposFor(web.id),
        cloudReach: sandboxes.reposFor(CLOUD),
        defaults: sandboxes.live().filter((each) => each.isDefault).length
      };

      // Started from its kept disk under a new name: the same id, so the same save.
      sandboxes.delete("cloud");
      const revived = sandboxes.create({ name: "site", repos: ["me/web"], from: web.id }, () => false);
      const forgetLive = refusal(() => sandboxes.forget(revived.id));
      sandboxes.forget(CLOUD);

      return {
        web,
        refusals,
        overCap,
        defaults,
        afterDelete,
        revived,
        reach: sandboxes.reposFor(revived.id),
        forgetLive,
        cloud: sandboxes.get(CLOUD) ?? null
      };
    });

    expect(result.web).toMatchObject({ name: "web", repos: ["me/web"], isDefault: false });
    expect(result.web.id).toMatch(/^sb-[0-9a-f]{8}$/);
    expect(result.refusals).toEqual({
      badName: "A name is lowercase letters, digits and dashes, up to 32.",
      takenByComputer: "mac is taken; pick another name.",
      takenBySandbox: "web is taken; pick another name.",
      badRepo: 'A repo is owner/name, not "api".',
      ownedRepo: "me/web is already web's; a repo belongs to one sandbox.",
      idle: "Idle minutes are a whole number from 1 to 1440.",
      stealRepo: "me/web is already web's; a repo belongs to one sandbox."
    });
    expect(result.overCap).toBe(`ky runs at most ${SANDBOX_CAP} sandboxes; delete one first.`);
    expect(result.defaults).toEqual(["web"]);
    expect(result.afterDelete).toEqual({ owner: null, reposFor: null, cloudReach: "all", defaults: 0 });
    expect(result.revived).toMatchObject({ id: result.web.id, name: "site", repos: ["me/web"], deletedAt: null });
    expect(result.reach).toEqual(["me/web"]);
    expect(result.forgetLive).toBe(`No kept disk ${result.web.id}.`);
    expect(result.cloud).toBeNull();
  });
});

describe("routing a task to a sandbox", () => {
  it("goes to the named machine, else the repo's sandbox, else the default, and refuses the wrong sandbox", async () => {
    const name = fresh();
    const web = await inside(name, (instance) => instance.createSandbox({ name: "web", repos: ["me/web"] }));
    const run = (args: { prompt: string; machine?: string; repo?: string }) => prompt(name, `tool machine ${JSON.stringify({ action: "run", ...args })}`);
    // The feed lists the newest task first.
    // Machine runs only: the chat's own background passes (an episode reflection after six prompts) show in the feed too.
    const runs = async () => (await tasks(name)).filter((task) => task.kind === "machine");
    const latest = async () => (await runs())[0]?.worker;

    // Listed with the cloud machine, as sandboxes, before any wakes.
    expect(await inside(name, (instance) => instance.machines.machines().map((machine) => [machine.name, machine.sandbox?.id ?? null]))).toEqual([
      [CLOUD, CLOUD],
      ["web", web.id]
    ]);

    await run({ prompt: "fix the site", repo: "Me/Web" });
    expect(await latest()).toBe("web");

    await run({ prompt: "anything" });
    expect(await latest()).toBe(CLOUD);

    // The default with repos of its own: a repo no sandbox owns isn't sent there, however it was picked.
    await inside(name, (instance) => instance.changeSandbox(CLOUD, { repos: ["me/app"] }));
    expect((await run({ prompt: "fix the docs", repo: "me/docs" })).text).toContain(
      `me/docs is no sandbox's, and ${CLOUD} works only on its repos (me/app): name a computer for it`
    );
    await run({ prompt: "fix the app", repo: "me/app" });
    expect(await latest()).toBe(CLOUD);
    await inside(name, (instance) => instance.changeSandbox(CLOUD, { repos: [] }));
    expect(await runs()).toHaveLength(3);

    expect((await run({ prompt: "fix the site", machine: CLOUD, repo: "me/web" })).text).toContain(
      `me/web is the sandbox web's, not ${CLOUD}'s: run it on web, or leave machine out.`
    );
    expect((await run({ prompt: "fix the api", machine: "web", repo: "me/api" })).text).toContain("me/api is no sandbox's, and web works only on its repos (me/web)");
    // The cloud machine owns no repo, so it takes any other.
    await run({ prompt: "fix the api", machine: CLOUD, repo: "me/api" });
    expect(await runs()).toHaveLength(4);

    // A computer may work on the repo too, when it is named.
    const mac = await runner(name, "mac", FACTS);
    await run({ prompt: "fix it here", machine: "mac", repo: "me/web" });
    expect((await mac.run()).prompt).toContain("fix it here");

    // The repo's sandbox off: refused, not sent to the default.
    await inside(name, (instance) => instance.machines.change("web", { state: "off" }));
    expect((await run({ prompt: "fix the site", repo: "me/web" })).text).toContain("me/web is the sandbox web's, which is off");

    // The default moves, and the tool says where unnamed work goes.
    await inside(name, (instance) => {
      instance.machines.change("web", { state: "on" });
      instance.changeSandbox(web.id, { isDefault: true });
    });
    await run({ prompt: "anything else" });
    expect(await latest()).toBe("web");

    // A queued task doesn't move between sandboxes: each reaches only its own repos.
    const queued = await inside(name, (instance) => instance.feed.list()[0]!.id);
    expect((await prompt(name, `tool machine ${JSON.stringify({ action: "move", task: queued, machine: CLOUD })}`)).text).toContain(
      "a task doesn't move between sandboxes"
    );
    mac.socket.close();
  });

  it("wakes the sandbox a task went to, by its id", async () => {
    const name = fresh();
    const woken: string[] = [];

    const web = await inside(name, (instance) => {
      const sandbox = instance.createSandbox({ name: "web", repos: ["me/web"] });

      instance.machines.cloud = { ...instance.machines.cloud!, wake: (machine) => woken.push(machine) };

      return sandbox;
    });

    await prompt(name, `tool machine ${JSON.stringify({ action: "run", prompt: "fix the site", repo: "me/web" })}`);
    expect(await inside(name, () => woken)).toContain("web");

    // Its runner comes up under its name, and takes the task.
    const box = await runner(name, "web", CLOUD_FACTS);
    expect((await box.run()).prompt).toContain("fix the site");
    expect(await inside(name, (instance) => instance.sandboxNow(web.id))).toMatchObject({ name: "web", busy: true });
    box.socket.close();
  });

  it("asks the sandbox for a snapshot as each of its turns ends", async () => {
    const name = fresh();
    const ended: string[] = [];

    await inside(name, (instance) => {
      instance.createSandbox({ name: "web", repos: ["me/web"] });
      instance.machines.cloud = { wake: () => {}, turnEnded: (machine) => ended.push(machine) };
    });

    await prompt(name, `tool machine ${JSON.stringify({ action: "run", prompt: "fix the site", repo: "me/web" })}`);
    const box = await runner(name, "web", CLOUD_FACTS);
    const run = await box.run();

    expect(await inside(name, () => ended)).toEqual([]);
    box.send({ type: "result", task: run.task, turn: run.turn, ok: true, text: "fixed", session: null, agent: "claude" });
    await until(async () => (await inside(name, () => ended)).includes("web"), "the turn's end told to the sandbox");
    box.socket.close();
  });
});

describe("a sandbox's container", () => {
  it("brings a booked alarm forward to now when a turn ends, and books none when nothing runs", async () => {
    const sandbox = await created({ name: unique("web") });

    expect(
      await onBox(sandbox.id, async (instance, _box, state) => {
        await instance.turnEnded();
        const none = await state.storage.getAlarm();

        await state.storage.setAlarm(instance.clock() + 60_000);
        await instance.turnEnded();

        return { none, forward: ((await state.storage.getAlarm()) ?? Infinity) <= instance.clock() };
      })
    ).toEqual({ none: null, forward: true });
  });

  it("saves a running sandbox's disk to its own key as it is deleted, and a sandbox started from that disk gets it back", async () => {
    const sandbox = await created({ name: unique("web") });

    await onBox(sandbox.id, async (instance, box) => {
      await instance.primed(sandbox.id, "https://ky.test");
      box.up = true;
      box.state = "running";
      box.disk = "the web's work";
    });

    expect(await (await call(`/api/sandboxes/${sandbox.id}`, { method: "DELETE" })).json()).toEqual({ problem: null });
    expect(await (await env.FILES.get(saveKey(sandbox.id)))?.text()).toBe("the web's work");
    expect(await onBox(sandbox.id, async (instance, box) => ({ up: box.up, settled: await instance.settled() }))).toEqual({ up: false, settled: true });

    // Started again from the kept disk: the same id, and its first wake restores those bytes.
    const again = await created({ name: unique("site"), from: sandbox.id });
    expect(again.id).toBe(sandbox.id);
    await onBox(sandbox.id, (instance) => instance.primed(sandbox.id, "https://ky.test"));
    await task(again.name);
    await until(async () => (await onBox(sandbox.id, (_instance, box) => box.restored.length)) > 0, "the kept disk restored");
    expect(await onBox(sandbox.id, (_instance, box) => ({ restored: box.restored, starts: box.starts }))).toEqual({ restored: ["the web's work"], starts: 1 });

    await call(`/api/sandboxes/${sandbox.id}`, { method: "DELETE" });
    await call(`/api/sandboxes/kept/${sandbox.id}`, { method: "DELETE" });
  });

  it("refuses a start from a disk whose deleted sandbox is still saving it", async () => {
    const sandbox = await created({ name: unique("web") });

    await call(`/api/sandboxes/${sandbox.id}`, { method: "DELETE" });
    // A save that failed as it was deleted: the alarm tries again, and the disk isn't whole meanwhile.
    await onBox(sandbox.id, async (instance, _box, state) => {
      await instance.primed(sandbox.id, "https://ky.test");
      await state.storage.put("retiring", true);
    });

    const refused = await call("/api/sandboxes", json("POST", { name: unique("site"), from: sandbox.id }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ refused: "That disk is still being saved: try again in a minute." });

    // The alarm's retry retires it, and then the disk may be started from.
    await onBox(sandbox.id, (instance) => instance.tick());
    expect(await onBox(sandbox.id, (instance) => instance.settled())).toBe(true);
    expect((await call("/api/sandboxes", json("POST", { name: unique("site"), from: sandbox.id }))).status).toBe(201);

    await call(`/api/sandboxes/${sandbox.id}`, { method: "DELETE" });
    await call(`/api/sandboxes/kept/${sandbox.id}`, { method: "DELETE" });
  });

  it("sleeps after the sandbox's own idle minutes, not the deploy's", async () => {
    const sandbox = await created({ name: unique("web") });

    await call(`/api/sandboxes/${sandbox.id}`, json("PATCH", { idleMinutes: 30 }));
    await onBox(sandbox.id, async (instance, box) => {
      await instance.primed(sandbox.id, "https://ky.test");
      box.up = true;
      box.state = "running";
      box.disk = "idle work";
    });

    // Past the deploy's 10 minutes, short of its 30: still up.
    await onBox(sandbox.id, async (instance) => {
      await instance.idleFor(20 * 60_000);
      await instance.tick();
    });
    expect(await onBox(sandbox.id, (_instance, box) => box.up)).toBe(true);

    await onBox(sandbox.id, async (instance) => {
      await instance.idleFor(31 * 60_000);
      await instance.tick();
    });
    expect(await onBox(sandbox.id, (_instance, box) => box.up)).toBe(false);
    expect(await (await env.FILES.get(saveKey(sandbox.id)))?.text()).toBe("idle work");

    await call(`/api/sandboxes/${sandbox.id}`, { method: "DELETE" });
    await call(`/api/sandboxes/kept/${sandbox.id}`, { method: "DELETE" });
  });

  it("stops a container its sandbox was deleted under as it started", async () => {
    const sandbox = await created({ name: unique("web") });

    await onBox(sandbox.id, async (instance, box) => {
      await instance.primed(sandbox.id, "https://ky.test");
      // The delete lands after the start paired as it, before the container is up.
      box.onStart = async () => {
        await env.PiAgent.getByName("me").deleteSandbox(sandbox.id);
      };
    });

    await task(sandbox.name);
    await until(async () => (await onBox(sandbox.id, (_instance, box) => box.destroys)) === 1, "the container stopped");
    expect(await onBox(sandbox.id, (_instance, box) => ({ starts: box.starts, up: box.up, restored: box.restored }))).toEqual({ starts: 1, up: false, restored: [] });
    expect(await inside("me", (instance) => instance.machines.machine(sandbox.name))).toBeUndefined();
    expect(await env.FILES.head(saveKey(sandbox.id))).toBeNull();

    await onBox(sandbox.id, (instance) => instance.retire());
    await call(`/api/sandboxes/kept/${sandbox.id}`, { method: "DELETE" });
  });
});

describe("a sandbox's GitHub", () => {
  it("lets a sandbox reach its own repos only: not another sandbox's, and nothing once deleted", async () => {
    const [a, b] = [unique("alpha"), unique("beta")];
    const [repoA, repoB] = [`me/${a}`, `me/${b}`];
    // SAFETY: src/tests/wrangler.jsonc binds Vault to the test stack's subclass.
    const vault = (env.Vault as DurableObjectNamespace<TestVault>).getByName("owner");
    await vault.put("github", SUBSCRIPTION, { token: "github_pat_test", repos: [repoA, repoB] }, { repos: [repoA, repoB] });
    const sandboxA = await created({ name: a, repos: [repoA] });
    await created({ name: b, repos: [repoB] });
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));

    // github.internal as the CloudMachine registers it for a sandbox: its id in the props.
    const as = (id: string) => exports.GithubProxy({ props: { machine: id } });
    const clone = (id: string, repo: string) => as(id).fetch(`http://github.internal/api/git/${repo}.git/info/refs?service=git-upload-pack`);

    const push = (id: string, repo: string) =>
      as(id).fetch(`http://github.internal/api/git/${repo}.git/git-receive-pack`, {
        method: "POST",
        body: `${pkt(`${"0".repeat(40)} ${"1".repeat(40)} refs/heads/ky/fix\0report-status\n`)}0000PACK`
      });

    try {
      expect((await clone(sandboxA.id, repoA)).status).toBe(200);
      expect((await clone(sandboxA.id, repoB)).status).toBe(403);
      expect((await push(sandboxA.id, repoB)).status).toBe(403);
      expect((await push(sandboxA.id, repoA)).status).toBe(200);
      // cloud has no repos of its own: it reaches every picked one.
      expect((await clone(CLOUD, repoB)).status).toBe(200);
      // An id no sandbox has, and a deleted sandbox: no login at all.
      expect((await clone("sb-00000000", repoA)).status).toBe(401);
      await call(`/api/sandboxes/${sandboxA.id}`, { method: "DELETE" });
      expect((await clone(sandboxA.id, repoA)).status).toBe(401);
      expect(upstream.mock.calls.map(([url]) => String(url))).toEqual([
        `https://github.com/${repoA}.git/info/refs?service=git-upload-pack`,
        `https://github.com/${repoA}.git/git-receive-pack`,
        `https://github.com/${repoB}.git/info/refs?service=git-upload-pack`
      ]);
    } finally {
      upstream.mockRestore();
      await vault.remove("github", SUBSCRIPTION);
    }
  });
});

describe("Settings › Machines › sandboxes", () => {
  it("creates, changes and deletes a sandbox, keeping its disk until that is deleted too", async () => {
    const web = unique("web");
    const repo = `me/${web}`;

    const created = await call("/api/sandboxes", json("POST", { name: web, repos: [repo] }));
    expect(created.status).toBe(201);
    const sandbox = await created.json<Sandbox>();

    expect((await call("/api/sandboxes", json("POST", { name: web }))).status).toBe(409);
    expect(await (await call("/api/sandboxes", json("POST", { name: unique("api"), repos: [repo] }))).json()).toEqual({
      refused: `${repo} is already ${web}'s; a repo belongs to one sandbox.`
    });
    expect((await call("/api/sandboxes", json("POST", { repos: [] }))).status).toBe(400);

    // No runner pairs as it, and it isn't unpaired: it is deleted.
    const { code } = await pairingCode();
    expect((await pair({ code, name: web, facts: FACTS })).status).toBe(409);
    expect((await call(`/api/runners/${web}`, { method: "DELETE" })).status).toBe(409);

    expect(await (await call(`/api/sandboxes/${sandbox.id}`, json("PATCH", { idleMinutes: 45 }))).json()).toMatchObject({ idleMinutes: 45 });
    expect((await call(`/api/sandboxes/${sandbox.id}`, json("PATCH", { idleMinutes: 5000 }))).status).toBe(400);

    await env.FILES.put(saveKey(sandbox.id), "its disk");
    const listed = await (await call("/api/sandboxes")).json<SandboxesView>();
    expect(listed).toMatchObject({ enabled: true, cap: SANDBOX_CAP, saves: { [sandbox.id]: { size: 8 } } });

    expect(await (await call(`/api/sandboxes/${sandbox.id}`, { method: "DELETE" })).json()).toEqual({ problem: null });
    expect(await inside("me", (instance) => instance.machines.machine(web))).toBeUndefined();
    expect((await call(`/api/sandboxes/${sandbox.id}`, { method: "DELETE" })).status).toBe(404);

    const kept = (await (await call("/api/sandboxes")).json<SandboxesView>()).kept.find((each) => each.id === sandbox.id);
    expect(kept).toMatchObject({ name: web, repos: [repo], save: { size: 8 } });

    // A new sandbox from the kept disk takes its id, so it wakes with its save.
    const again = await (await call("/api/sandboxes", json("POST", { name: unique("site"), from: sandbox.id }))).json<Sandbox>();
    expect(again.id).toBe(sandbox.id);
    expect((await call(`/api/sandboxes/kept/${sandbox.id}`, { method: "DELETE" })).status).toBe(404);

    await call(`/api/sandboxes/${sandbox.id}`, { method: "DELETE" });
    expect((await call(`/api/sandboxes/kept/${sandbox.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await env.FILES.head(saveKey(sandbox.id))).toBeNull();
    expect((await (await call("/api/sandboxes")).json<SandboxesView>()).kept.map((each) => each.id)).not.toContain(sandbox.id);
  });

  it("keeps the sandboxes behind the owner's sign-in", async () => {
    const signedOut = { headers: { [ASSERTION]: "" } };

    expect((await call("/api/sandboxes", signedOut)).ok).toBe(false);
    expect((await call("/api/sandboxes", { ...json("POST", { name: unique("web") }), ...signedOut })).ok).toBe(false);
  });
});
