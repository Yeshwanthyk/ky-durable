import fc from "fast-check";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Semaphore from "effect/Semaphore";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Desk, forget, move, seat, Sessions } from "../../src/browse/browse";
import { type Browsers, loginId, type LoginVault, ownedLogin, type Seat } from "../../src/browse/contract";
import { Sql } from "../../src/core/sql";
import { isMac } from "../../src/machines/contract";
import { confine, place } from "../../src/machines/tool";
import { PROTOCOL } from "../../src/machines/runner-protocol";
import { MachineHub } from "../../src/machines/wiring";
import type { MachineInfo } from "../../src/protocol";
import { type AccessChange, KY, type Machinery, type Profile, SKILL_TABLES, SpecialistAction, type SessionKind, type Spawn } from "../../src/skills/contract";
import { MANAGE } from "../../src/skills/specialists";
import { Specialists } from "../../src/skills/wiring";
import { wired } from "../parity/automations/world";
import { settle, World } from "../parity/machines/world";
import { storageOf } from "../parity/skills/storage";

/**
 * The seven rules of specialist profiles (Specialists.tla under explainers/ky-architecture/tla), headed as
 * BRIEF2 names them. Phase 2 holds what the profile itself owes: whose a conversation is, what a profile
 * says when it is read, that only the user changes one, and that rows from before profiles open. What the
 * tools, runs, logins and deletion keep are todos under their rule until those phases land.
 */

const MACS = ["mbp", "studio"] as const;

/** A ky with the default sandbox, two paired Macs, and a sandbox for each specialist that asks. */
function world() {
  const sandboxes = [{ id: "cloud", name: "cloud", isDefault: true }];
  const opened: string[] = [];

  const machines: Machinery = {
    sandboxes: () => sandboxes,
    macs: () => MACS,
    open: (name) => {
      if (sandboxes.some((sandbox) => sandbox.name === name)) throw new Error(`${name} is taken; pick another name.`);
      const made = { id: `sb-${name}`, name, isDefault: false };
      sandboxes.push(made);
      opened.push(name);

      return made;
    }
  };

  const db = new DatabaseSync(":memory:");

  return { db, sandboxes, opened, specialists: new Specialists(storageOf(db), machines) };
}

const NEW = { description: "Builds things.", brief: "Be terse." };

const T = 1_760_000_000_000;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
});

const COMPUTER = {
  os: "darwin",
  chrome: true,
  repos: [],
  agents: { claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } },
  ports: [],
  kind: "computer" as const
};

/**
 * ky's real machine hub and task feed, as server.ts wires them to the specialists: the default sandbox, a
 * spare one, two paired Macs (offline: no runner has said hello), and each specialist made by the user, with
 * its own sandbox and a home conversation.
 */
function fleet() {
  const world = new World(T);
  const hub = new MachineHub(world.durable.storage(), world.feed, world.socketsOf, world.files, world.tokens, world.creds, world.sandboxes);

  for (const mac of MACS) hub.paired(mac, COMPUTER, `p-${mac}`);

  const machines: Machinery = {
    sandboxes: () => world.sandboxes.live(),
    macs: () => hub.machines().flatMap((machine) => (isMac(machine) ? [machine.name] : [])),
    open: (name) => {
      const made = world.sandboxes.create({ name, isDefault: false }, (taken) => hub.machine(taken) !== undefined);
      hub.listSandboxes();

      return made;
    }
  };

  const specialists = new Specialists(storageOf(new DatabaseSync(":memory:")), machines);
  hub.attach(world.harness);
  hub.listSandboxes();
  hub.adopt = (task, parent) => specialists.adopt(task, parent);
  specialists.onChange(() => void confine(hub, world.feed, specialists));

  for (const id of IDS) {
    specialists.create(id, NEW, "user");
    specialists.attach(`home-${id}`, id, "home");
  }

  return { world, hub, specialists };
}

const IDS = ["engineer", "researcher", "fin"] as const;

const anId = fc.constantFrom(...IDS);

const anOwner = fc.constantFrom(KY, ...IDS);

/** The user gives a specialist a Mac, or takes it back. */
const aGrant = fc.record({ id: anId, mac: fc.constantFrom(...MACS), grant: fc.boolean() });

/** A machine a run names: a Mac, ky's sandboxes, a specialist's, or one ky has never heard of. */
const aRequest = fc.constantFrom<string>(...MACS, "cloud", "lab", ...IDS, "laptop");

const aKind = fc.constantFrom<SessionKind>("home", "consult", "discuss", "group");

const aSession = fc.constantFrom("s1", "s2", "s3", "s4", "s5");

/** What the user does to a specialist's machines, in Settings or on a card. */
const aChange = fc.record({
  id: anId,
  change: fc.oneof(
    fc.record({ mac: fc.constantFrom(...MACS), grant: fc.boolean() }),
    fc.record({ home: fc.constantFrom("cloud", "sb-engineer", "sb-researcher", "sb-fin") })
  )
});

const made = () => {
  const ky = world();

  for (const id of IDS) ky.specialists.create(id, NEW, "ky");

  return ky;
};

/** A change as the user makes it: one that is refused changes nothing. */
function tried(specialists: Specialists, id: string, change: AccessChange): boolean {
  try {
    specialists.changeAccess(id, change);

    return true;
  } catch {
    return false;
  }
}

/**
 * ky's real automations, wired as server.ts wires them: owners and pins from the real specialists, and the
 * two Macs, each online or not as the test says. What a run started on, what it was spawned as, and what
 * it told its chat are kept.
 */
function workflows() {
  const { specialists } = made();
  const online = new Set<string>();
  const started: Array<{ readonly task: string; readonly machine: string }> = [];
  const spawned: Array<Parameters<Spawn>[2]> = [];
  const info = (name: string): MachineInfo => ({ name, online: online.has(name), seenAt: 0, reason: null, active: 0, state: "on", note: "", facts: null, login: "own", cloud: null, sandbox: null });

  const { world, side, scheduler } = wired({ now: () => T }, (base, { feed }) => {
    const machines: Pick<MachineHub, "machines" | "machine" | "defaultAgent" | "start" | "stop" | "recheck"> = {
      machines: () => MACS.map(info),
      machine: (name) => (MACS.some((mac) => mac === name) ? info(name) : undefined),
      defaultAgent: () => "claude",
      start: (machine, title, _prompt, id, parent, source) => {
        started.push({ task: id, machine });
        const task = feed.create({ id, kind: "machine", source, worker: machine, title, status: "queued", session: null, agent: "claude" });
        specialists.adopt(id, parent);

        return task;
      },
      stop: async () => undefined,
      recheck: () => undefined
    };

    return {
      ...base,
      // SAFETY: automations call only these six of MachineHub.
      machines: machines as MachineHub,
      runtime: {
        ...base.runtime,
        spawn: async (_tx, owner, request) => {
          spawned.push(request);

          return owner;
        }
      },
      pin: (id, profile) => specialists.pin(id, profile),
      owners: (owner) => (owner === KY || specialists.has(owner) ? { profile: specialists.profile(owner), model: null } : undefined)
    };
  });

  const told = () => world.effects.flatMap((effect) => ("deliver" in effect ? [JSON.stringify(effect.deliver)] : []));

  /** Run it now, as the user's Run does: booked now, and fired. */
  const run = async (id: string) => {
    await side.run(id);
    await scheduler.due();
  };

  /** Save it as the user does; its id. */
  const save = async (draft: ReturnType<typeof workflow>) => {
    const saved = await side.create(draft, "user");

    if ("refused" in saved) throw new Error(saved.refused);

    return saved.id;
  };

  /** Who the first run started runs as: what its cloud run was spawned as, or what its machine task is pinned to now. */
  const runAs = (): Profile | undefined => {
    const cloud = spawned[0]?.as;

    if (cloud !== undefined) return structuredClone(cloud);
    const task = started[0]?.task;

    return task === undefined ? undefined : specialists.profileOf(task);
  };

  return { world, side, save, run, runAs, specialists, online, started, spawned, told };
}

/** A workflow for an hour from now, for `owner`, on `machine` (null: the cloud). */
const workflow = (owner: string, machine: string | null) => ({
  title: "Digest",
  prompt: "digest the news",
  cron: null,
  at: T + 3_600_000,
  model: null,
  machine,
  chat: "1",
  gate: null,
  owner
});

/** Every specialist tool action, with ids that are and aren't specialists. */
const aToolInput = fc.record({
  action: fc.constantFrom(...SpecialistAction.anyOf.map((each) => each.const)),
  id: fc.constantFrom(...IDS, "old-bot", "new-one"),
  description: fc.constant("Still builds things."),
  brief: fc.constant("Be brief."),
  machine: fc.constantFrom(...MACS, "cloud", "sb-fin", "build")
});

function runTool(specialists: Specialists, inputs: readonly (typeof aToolInput extends fc.Arbitrary<infer T> ? T : never)[]): void {
  for (const input of inputs) {
    try {
      MANAGE[input.action](specialists, input, "main");
    } catch {
      // Refused: the tool says why.
    }
  }
}

const SITES = ["bank.test", "mail.test", "shop.test"] as const;

/** What happens to logins: a sign-in through `owner`'s browser keeps the site, Remove and Move to in Settings, a browse that seats `owner`. */
const aLoginStep = fc.oneof(
  fc.record({ step: fc.constant("sign-in" as const), owner: anOwner, site: fc.constantFrom(...SITES) }),
  fc.record({ step: fc.constant("remove" as const), owner: anOwner, site: fc.constantFrom(...SITES) }),
  fc.record({ step: fc.constant("move" as const), owner: anOwner, site: fc.constantFrom(...SITES), to: anOwner }),
  fc.record({ step: fc.constant("browse" as const), owner: anOwner })
);

type LoginStep = typeof aLoginStep extends fc.Arbitrary<infer S> ? S : never;

/** A Browser Run session: the sites restored or signed in to in it, until it ends. */
type Live = { readonly sites: Set<string>; ended: boolean };

const cookieFor = (site: string) => ({ name: "sid", value: "x", domain: site, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const });

/** The seat browse.ts drives: it restores logins into it and ends it; nothing here opens a page. */
function seatOf(held: Live): Seat {
  const never = () => Promise.reject(new Error("no pages in this world"));

  return {
    newTab: never,
    lastTab: never,
    tab: never,
    handoff: never,
    liveView: never,
    complete: never,
    record: never,
    recorded: never,
    storageState: never,
    restore: async (state) => state.cookies.forEach((cookie) => held.sites.add(cookie.domain)),
    end: async () => {
      held.ended = true;
    },
    close: async () => undefined
  };
}

/** The real seat, forget and move over a fake Browser Run and a fake Vault. */
function logins() {
  const db = new DatabaseSync(":memory:");
  const runtime = ManagedRuntime.make(Sessions.layer.pipe(Layer.provide(Sql.layer(storageOf(db)))));
  const browser = new Map<string, Live>();
  const vault = new Map<string, string>();
  const owners = new Map<string, string>();

  const browsers: Browsers = {
    kitesurf: () => Promise.reject(new Error("no kitesurf in this world")),
    acquire: async () => {
      const session = `s${browser.size + 1}`;

      browser.set(session, { sites: new Set(), ended: false });

      return session;
    },
    connect: async (session) => {
      const held = browser.get(session);

      if (held === undefined || held.ended) throw new Error(`${session} has ended`);

      return seatOf(held);
    }
  };

  const keeps: LoginVault = {
    status: async () => [],
    put: async () => undefined,
    remove: async () => undefined,
    browserLogins: async (owner) => [...vault].flatMap(([id, state]) => (ownedLogin(id).owner === owner ? [{ site: ownedLogin(id).site, state }] : [])),
    move: async (_kind, id, to) => {
      const state = vault.get(id);

      if (state === undefined) return false;
      vault.delete(id);
      vault.set(to, state);

      return true;
    }
  };

  const desk: Desk = { browsers, vault: () => keeps, lock: Semaphore.makeUnsafe(1) };
  const settle = (work: Effect.Effect<unknown, unknown, Sessions>) => runtime.runPromise(Effect.ignore(work));
  const current = (owner: string) => runtime.runPromise(Effect.flatMap(Sessions, (sessions) => sessions.current(owner)));

  return {
    async run(step: LoginStep) {
      if (step.step === "browse") await settle(seat(desk, step.owner));

      // As a hand-off's finish keeps it: signed in to in the owner's session, then saved under the owner.
      if (step.step === "sign-in") {
        await settle(seat(desk, step.owner));
        const session = await current(step.owner);

        if (session !== undefined) browser.get(session)?.sites.add(step.site);
        vault.set(loginId(step.owner, step.site), JSON.stringify({ cookies: [cookieFor(step.site)], origins: [] }));
      }

      // As src/browse/routes.ts removes one: from the Vault, then the owner's session ends.
      if (step.step === "remove") {
        vault.delete(loginId(step.owner, step.site));
        await settle(forget(desk, step.owner));
      }

      if (step.step === "move" && step.to !== step.owner) await settle(move(desk, step.owner, step.site, step.to));
      owners.clear();

      for (const owner of [KY, ...IDS]) {
        const session = await current(owner);

        if (session !== undefined) owners.set(session, owner);
      }
    },
    live: () => [...browser].flatMap(([session, { sites, ended }]) => (ended ? [] : [[session, sites] as const])),
    ownerOf: (session: string) => owners.get(session),
    kept: (owner: string) => new Set([...vault.keys()].flatMap((id) => (ownedLogin(id).owner === owner ? [ownedLogin(id).site] : [])))
  };
}

describe("R1 RunnerScope: work runs only on its owner's sandbox or allowed Macs", () => {
  it("gives a new specialist a sandbox of its own, never the default, and no Mac but the one the user named", () => {
    const { specialists, opened, sandboxes } = world();

    specialists.create("engineer", { ...NEW, machine: "mbp" }, "user");
    specialists.create("researcher", { ...NEW, machine: "mbp" }, "agent");

    expect(opened).toEqual(["engineer", "researcher"]);
    expect(sandboxes.filter((sandbox) => sandbox.isDefault).map((sandbox) => sandbox.id)).toEqual(["cloud"]);
    const home = (id: string) => ({ id: `sb-${id}`, name: id });
    expect(specialists.profile("engineer")).toEqual({ owner: "engineer", home: home("engineer"), sandboxes: [home("engineer")], macs: ["mbp"], tools: {} });
    expect(specialists.profile("researcher")).toEqual({ owner: "researcher", home: home("researcher"), sandboxes: [home("researcher")], macs: [], tools: {} });
    expect(specialists.profile(KY)).toEqual({ owner: KY, home: { id: "cloud", name: "cloud" }, sandboxes: [{ id: "cloud", name: "cloud" }], macs: [...MACS], tools: {} });
  });

  it("has no sandbox when it can't get one, rather than borrowing ky's", () => {
    const { specialists } = world();

    specialists.create("cloud", NEW, "user");

    expect(specialists.profile("cloud")).toMatchObject({ home: null, sandboxes: [] });
  });

  it("gives ky's own example specialist its sandbox when it is first asked, not when it is made", () => {
    const { specialists, opened } = world();

    specialists.seed("editor", NEW);
    expect(opened).toEqual([]);
    specialists.attach("s1", "editor", "home");

    expect(specialists.profileOf("s1").home).toEqual({ id: "sb-editor", name: "editor" });
  });

  it("refuses a Mac that isn't paired, a sandbox that isn't live, and a sandbox that is another owner's", () => {
    const { specialists } = made();

    expect(() => specialists.changeAccess("engineer", { mac: "laptop", grant: true })).toThrow("laptop isn't one of your paired Macs.");
    expect(() => specialists.changeAccess("engineer", { home: "sb-gone" })).toThrow("No sandbox sb-gone.");
    expect(() => specialists.changeAccess("engineer", { home: "cloud" })).toThrow("cloud is ky's default sandbox.");
    expect(() => specialists.changeAccess("engineer", { home: "sb-fin" })).toThrow("fin is @fin's sandbox.");
    expect(() => specialists.changeAccess("nobody", { mac: "mbp", grant: true })).toThrow("No specialist @nobody.");
  });

  it("lets nothing the specialist tool does give a specialist a Mac or another sandbox", () => {
    fc.assert(
      fc.property(fc.array(aToolInput, { maxLength: 8 }), (inputs) => {
        const { specialists } = made();
        const before = specialists.access();

        runTool(specialists, inputs);

        for (const [id, access] of Object.entries(specialists.access())) expect(access).toEqual(before[id] ?? { home: `sb-${id}`, macs: [] });
      })
    );
  });

  it("drops every grant of a Mac removed from ky", () => {
    const { specialists } = made();

    for (const id of IDS) specialists.changeAccess(id, { mac: "mbp", grant: true });
    specialists.changeAccess("fin", { mac: "studio", grant: true });
    specialists.dropMac("mbp");

    expect(IDS.map((id) => specialists.profile(id).macs)).toEqual([[], [], ["studio"]]);
  });

  it("keeps ky off every specialist's sandbox", () => {
    const { specialists } = made();

    expect(specialists.profile(KY).sandboxes).toEqual([{ id: "cloud", name: "cloud" }]);
  });

  it("puts a specialist's run only on its own sandbox or a Mac it was granted, and ky's never on a specialist's sandbox", () => {
    fc.assert(
      fc.property(fc.array(aGrant, { maxLength: 6 }), anOwner, fc.option(aRequest, { nil: undefined }), fc.constantFrom(undefined, "acme/api"), (grants, owner, requested, repo) => {
        const { hub, specialists } = fleet();

        for (const { id, mac, grant } of grants) tried(specialists, id, { mac, grant });
        const profile = specialists.profile(owner);
        const own = [profile.home?.name, ...profile.macs];
        const placed = place(hub.machines(), profile, requested, repo);

        if ("refusal" in placed) {
          if (owner !== KY && requested !== undefined && !own.includes(requested)) expect(placed.refusal).toContain(`@${owner} can't use ${requested}; only the user can give it one — ask them.`);

          return;
        }

        if (owner === KY) expect(IDS.map((id) => specialists.profile(id).home?.name)).not.toContain(placed.name);
        else expect(own).toContain(placed.name);
      }),
      { numRuns: 40 }
    );
  });

  it("revoking a Mac stops the owner's runs on it, queued or sent, tells the conversation that started each, and leaves every other run", async () => {
    let ran = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(aGrant, { maxLength: 6 }), fc.array(fc.record({ owner: anOwner, mac: fc.constantFrom(...MACS) }), { maxLength: 6 }), fc.array(aGrant, { maxLength: 6 }), fc.boolean(), async (before, starts, after, online) => {
        const { world, hub, specialists } = fleet();

        // A runner on studio says hello, so a run there goes out to it rather than waiting.
        if (online) await hub.onReport("studio", { type: "hello", protocol: PROTOCOL, version: "test", active: [], facts: COMPUTER }, "c1");

        for (const { id, mac, grant } of before) tried(specialists, id, { mac, grant });

        const started = starts.flatMap(({ owner, mac }, at) => {
          const conversation = owner === KY ? "main" : `home-${owner}`;

          if ("refusal" in place(hub.machines(), specialists.profileOf(conversation), mac)) return [];

          return [{ id: hub.start(mac, "a job", "do it", `m-${at}`, conversation).id, owner, mac, conversation }];
        });

        const lost = new Set<string>();

        for (const { id, mac, grant } of after) {
          tried(specialists, id, { mac, grant });
          await settle();

          if (!grant) lost.add(`${id}:${mac}`);
        }

        ran += started.length;

        for (const run of started) {
          const task = world.feed.get(run.id);
          const kept = !lost.has(`${run.owner}:${run.mac}`);

          const told = world.effects.pi.some((each) => {
            const posted = JSON.stringify(each);

            return posted.includes(`"session":"${run.conversation}"`) && posted.includes(`@${run.owner} may no longer use ${run.mac}`);
          });

          expect(specialists.profileOf(run.id).owner).toBe(run.owner);
          expect({ stopped: task?.status === "stopped", told }).toEqual({ stopped: !kept, told: !kept });
        }
      }),
      { numRuns: 25 }
    );
    expect(ran).toBeGreaterThan(0);
  });
});

describe("R2 SessionMatchesVault: a live browser session holds only logins its owner has in the Vault", () => {
  it("after any sign-ins, moves and removals, each live session holds only its owner's logins", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(aLoginStep, { minLength: 1, maxLength: 30 }), async (steps) => {
        const here = logins();

        for (const step of steps) {
          await here.run(step);

          for (const [session, held] of here.live()) {
            const owner = here.ownerOf(session);

            expect(owner, `${session} is live but no owner's session`).toBeDefined();
            expect([...held].filter((site) => !here.kept(owner ?? "").has(site)), `${owner}'s session holds a login it doesn't keep`).toEqual([]);
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});

describe("R3 DeleteCleans: a deleted specialist has no runs, sessions, logins, keys or Mac grants", () => {
  it("leaves a deleted specialist's conversations its own, with nothing granted", () => {
    fc.assert(
      fc.property(anId, aKind, fc.array(aChange, { maxLength: 4 }), (id, kind, changes) => {
        const { specialists } = made();
        specialists.attach("s1", id, kind);

        for (const { id: each, change } of changes) tried(specialists, each, change);
        specialists.delete(id);

        expect(specialists.profileOf("s1")).toEqual({ owner: id, home: null, sandboxes: [], macs: [], tools: {} });
      })
    );
  });

  it("refuses a new specialist under a deleted one's id, so it inherits none of its conversations or brief", () => {
    const { specialists } = made();
    specialists.delete("engineer");

    expect(() => specialists.create("engineer", NEW, "user")).toThrow("@engineer was deleted; pick another id.");
  });

  it.todo("deleting a specialist ends its runs and sessions, removes its logins, keys and grants, and gives its workflows to ky, paused (Phase 4)");
});

describe("R4 NoSilentFallback: a workflow whose Mac is offline waits and tells; never runs on another machine", () => {
  it("a run for a machine its owner may use goes to that machine, offline or not; one it may not use is refused, never sent elsewhere", () => {
    fc.assert(
      fc.property(fc.array(aGrant, { maxLength: 6 }), anOwner, aRequest, (grants, owner, requested) => {
        const { hub, specialists } = fleet();

        for (const { id, mac, grant } of grants) tried(specialists, id, { mac, grant });
        const placed = place(hub.machines(), specialists.profile(owner), requested);

        expect(["refusal" in placed, "name" in placed && placed.name === requested]).toContain(true);
      }),
      { numRuns: 40 }
    );
  });

  it("an owned workflow's run goes to its Mac alone, waits and says so when that Mac is offline, and doesn't start once the Mac is taken back", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(aGrant, { maxLength: 4 }), anId, fc.constantFrom(...MACS), fc.boolean(), fc.boolean(), async (grants, owner, mac, up, revoke) => {
        const ky = workflows();

        try {
          for (const { id, mac: each, grant } of grants) tried(ky.specialists, id, { mac: each, grant });

          if (up) ky.online.add(mac);
          const made = await ky.side.create(workflow(owner, mac), "user");

          if (!ky.specialists.profile(owner).macs.includes(mac)) {
            expect(made).toHaveProperty("refused", expect.stringMatching(new RegExp(`@${owner} may not use ${mac}`)));

            return;
          }

          if ("refused" in made) throw new Error(made.refused);

          if (revoke) tried(ky.specialists, owner, { mac, grant: false });
          await ky.run(made.id);
          const said = ky.told().join("\n");

          expect(ky.started.every((run) => run.machine === mac)).toBe(true);
          expect(ky.started.length).toBe(revoke ? 0 : 1);
          expect(said.includes(`did not run: @${owner} may not use ${mac}`)).toBe(revoke);
          expect(said.includes(`waits for ${mac}, which is offline`)).toBe(!revoke && !up);
        } finally {
          ky.world.db.close();
        }
      }),
      { numRuns: 60 }
    );
  });
});

describe("R5 OneOwnerPerRun: a run keeps the owner it started with", () => {
  it("a profile read is a snapshot: it keeps what it said while the user changes the owner's machines", () => {
    fc.assert(
      fc.property(anId, fc.array(aChange, { minLength: 1, maxLength: 8 }), (id, changes) => {
        const { specialists } = made();
        specialists.attach("s1", id, "home");
        const read = specialists.profileOf("s1");
        const copy = structuredClone(read);
        const macs = new Set<string>();

        for (const { id: each, change } of changes) {
          if (!tried(specialists, each, change) || each !== id || "home" in change) continue;

          if (change.grant) macs.add(change.mac);
          else macs.delete(change.mac);
        }

        expect(read).toEqual(copy);
        const now = specialists.profileOf("s1");
        expect(now.home?.id).toBe(`sb-${id}`);
        expect([...now.macs].sort()).toEqual([...macs].sort());
      })
    );
  });

  it("a workflow's run keeps the owner and profile it started with, while the user reassigns the workflow and changes machines", async () => {
    const aMove = fc.oneof(aChange.map((change) => ({ change })), anOwner.map((to) => ({ to })));

    await fc.assert(
      fc.asyncProperty(anId, fc.constantFrom<string | null>(null, ...MACS), fc.array(aMove, { minLength: 1, maxLength: 6 }), async (owner, machine, moves) => {
        const ky = workflows();

        try {
          for (const mac of MACS) tried(ky.specialists, owner, { mac, grant: true });
          const id = await ky.save(workflow(owner, machine));
          const before = structuredClone(ky.specialists.profile(owner));
          await ky.run(id);
          const at = ky.runAs();

          for (const move of moves) {
            if ("to" in move) await ky.side.update(id, { owner: move.to });
            else tried(ky.specialists, move.change.id, move.change.change);
          }

          const now = ky.specialists.profile(owner);
          const live = (sandbox: { readonly id: string }) => now.sandboxes.some((each) => each.id === sandbox.id);

          // A cloud run carries the profile read as it started; a machine task's is that, less what the user took back since.
          const expected =
            machine === null
              ? before
              : { ...before, home: before.home && live(before.home) ? before.home : null, sandboxes: before.sandboxes.filter(live), macs: before.macs.filter((mac) => now.macs.includes(mac)) };

          expect(at).toEqual(before);
          expect(ky.runAs()).toEqual(expected);
        } finally {
          ky.world.db.close();
        }
      }),
      { numRuns: 60 }
    );
  });
});

describe("R6 ToolEnforced: the tools enforce the profile, not the prompt", () => {
  it("profile resolution: each conversation is the specialist's it is attached to, and ky's otherwise", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ session: aSession, id: anId, kind: aKind }), { maxLength: 8 }), (attaches) => {
        const { specialists } = made();
        const owner = new Map<string, string>();

        for (const { session, id, kind } of attaches) {
          specialists.attach(session, id, kind);
          owner.set(session, id);
        }

        for (const session of ["s1", "s2", "s3", "s4", "s5", "main"]) expect(specialists.profileOf(session).owner).toBe(owner.get(session) ?? KY);
      })
    );
  });

  it("profile resolution: a conversation started from another is its owner's, however deep", () => {
    // Each conversation c<n> is started from an earlier one, or from a specialist's home or the main chat.
    const aTree = fc.array(fc.nat(), { minLength: 1, maxLength: 10 });

    fc.assert(
      fc.property(anId, aTree, (id, parents) => {
        const { specialists } = made();
        specialists.attach("home", id, "home");

        const roots = ["home", "main"];

        const owner = new Map([
          ["home", id],
          ["main", KY]
        ]);

        parents.forEach((pick, at) => {
          const parent = at === 0 ? (roots[pick % 2] ?? "main") : `c${pick % at}`;
          specialists.adopt(`c${at}`, parent);
          owner.set(`c${at}`, owner.get(parent) ?? KY);
        });

        for (const [conversation, expected] of owner) expect(specialists.profileOf(conversation).owner).toBe(expected);
      })
    );
  });

  it("the machine tool lets an owner name only its own machines: a specialist, its sandbox and the Macs it was given; ky, all but specialists' sandboxes", () => {
    fc.assert(
      fc.property(fc.array(aGrant, { maxLength: 6 }), anOwner, aRequest, (grants, owner, requested) => {
        const { hub, specialists } = fleet();

        for (const { id, mac, grant } of grants) tried(specialists, id, { mac, grant });
        const profile = specialists.profile(owner);
        const homes = IDS.map((id) => specialists.profile(id).home?.name);
        const mayUse = owner === KY ? !homes.includes(requested) : requested === profile.home?.name || profile.macs.includes(requested);
        const placed = place(hub.machines(), profile, requested);

        if (!mayUse) expect(placed).toHaveProperty("refusal", expect.stringMatching(owner === KY ? /is a specialist's own sandbox: ky can't use it/ : /can't use .+; only the user can give it one/));
        else expect("refusal" in placed ? placed.refusal : "").not.toMatch(/can't use/);
      }),
      { numRuns: 40 }
    );
  });

  it.todo("the browse, secret and executor tools refuse what the profile doesn't allow, whatever the prompt says (Phase 3C, 3D)");
});

describe("R7 NoLaundering: a change outside content led to needs the user's OK", () => {
  it.todo("a write or act from a conversation that read outside content, directly or through a delegation, waits for the user (Phase 1)");
});

describe("rows from before profiles", () => {
  /** A specialist as B wrote it: a row in ky_specialists, no profile; then the boot's migration. */
  function before(machine: string | null) {
    const { db, sandboxes, specialists } = world();
    db.prepare(`INSERT INTO ${SKILL_TABLES.specialists} (id, description, model, machine, session, created_at) VALUES ('old-bot', 'Was here first.', NULL, ?, NULL, 0)`).run(machine);
    sandboxes.push({ id: "sb-build", name: "build", isDefault: false });

    return specialists;
  }

  it("grant nothing until the boot migrates them", () => {
    expect(before("mbp").profile("old-bot")).toEqual({ owner: "old-bot", home: null, sandboxes: [], macs: [], tools: {} });
  });

  it("get a sandbox of their own at boot, and the Mac a hint named, once", () => {
    for (const [machine, macs] of [["build", []], ["mbp", ["mbp"]], [null, []]] as const) {
      const specialists = before(machine);
      specialists.migrate();
      specialists.migrate();

      expect(specialists.profile("old-bot")).toMatchObject({ home: { id: "sb-old-bot" }, macs });
    }
  });

  it("change their access through nothing the specialist tool does, before or after the boot", () => {
    fc.assert(
      fc.property(fc.array(aToolInput, { maxLength: 6 }), fc.array(aToolInput, { maxLength: 6 }), (early, late) => {
        const specialists = before(null);

        runTool(specialists, early);
        expect(specialists.profile("old-bot")).toMatchObject({ home: null, macs: [] });
        specialists.migrate();
        const migrated = specialists.profile("old-bot");
        runTool(specialists, late);

        expect(specialists.profile("old-bot")).toEqual(migrated);
      })
    );
  });

  it("read a damaged profile as granting nothing", () => {
    const { db, specialists } = made();

    db.prepare(`UPDATE ${SKILL_TABLES.specialistProfiles} SET macs = 'not json' WHERE specialist = 'engineer'`).run();

    expect(specialists.profile("engineer")).toEqual({ owner: "engineer", home: null, sandboxes: [], macs: [], tools: {} });
  });
});
