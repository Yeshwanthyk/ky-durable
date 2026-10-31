import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isMac } from "../../src/machines/contract";
import { confine, place } from "../../src/machines/tool";
import { MachineHub } from "../../src/machines/wiring";
import { type AccessChange, KY, type Machinery, SKILL_TABLES, SpecialistAction, type SessionKind } from "../../src/skills/contract";
import { MANAGE } from "../../src/skills/specialists";
import { Specialists } from "../../src/skills/wiring";
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

  it("revoking a Mac stops the owner's runs on it, tells the conversation that started each, and leaves every other run", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(aGrant, { maxLength: 6 }), fc.array(fc.record({ owner: anOwner, mac: fc.constantFrom(...MACS) }), { maxLength: 6 }), fc.array(aGrant, { maxLength: 6 }), async (before, starts, after) => {
        const { world, hub, specialists } = fleet();

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

        for (const run of started) {
          const task = world.feed.get(run.id);
          const kept = !lost.has(`${run.owner}:${run.mac}`);

          const told = world.effects.pi.some((each) => {
            const posted = JSON.stringify(each);

            return posted.includes(`"session":"${run.conversation}"`) && posted.includes(`@${run.owner} may no longer use ${run.mac}`);
          });

          expect(specialists.profileOf(run.id).owner).toBe(run.owner);
          expect({ status: task?.status, told }).toEqual(kept ? { status: "queued", told: false } : { status: "stopped", told: true });
        }
      }),
      { numRuns: 25 }
    );
  });
});

describe("R2 SessionMatchesVault: a live browser session holds only logins its owner has in the Vault", () => {
  it.todo("moving or removing a login logs out every session that holds it (Phase 3C)");
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

  it.todo("an owned workflow's run waits for its offline Mac and tells the user (Phase 3B)");
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

  it.todo("a workflow's run keeps the profile it started with, even if the workflow is reassigned (Phase 3B)");
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

        if (!mayUse) expect(placed).toHaveProperty("refusal");
        else expect(placed).not.toHaveProperty("refusal", expect.stringContaining("can't use"));
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
