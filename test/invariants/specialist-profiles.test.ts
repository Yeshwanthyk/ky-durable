import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type AccessChange, KY, type Machinery, SKILL_TABLES, SpecialistAction, type SessionKind } from "../../src/skills/contract";
import { MANAGE } from "../../src/skills/specialists";
import { Specialists } from "../../src/skills/wiring";
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

const IDS = ["engineer", "researcher", "fin"] as const;

const anId = fc.constantFrom(...IDS);

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

  it.todo("a machine task of a specialist's runs only on its home sandbox or a Mac it was granted (Phase 3A)");
  it.todo("revoking a Mac stops the owner's runs on it (Phase 3A)");
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

  it.todo("the machine, browse, secret and executor tools refuse what the profile doesn't allow, whatever the prompt says (Phase 3)");
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
