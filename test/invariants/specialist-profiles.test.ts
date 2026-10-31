import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { KY, type Machinery, SKILL_TABLES, SpecialistAction, type SessionKind } from "../../src/skills/contract";
import { MANAGE } from "../../src/skills/specialists";
import { Specialists } from "../../src/skills/wiring";
import { storageOf } from "../parity/skills/storage";

/**
 * The seven rules of specialist profiles (Specialists.tla under explainers/ky-architecture/tla). Phase 2
 * holds what the profile itself owes: who a conversation's owner is, what a profile says at the moment it
 * is read, that only the user changes one, and that rows from before profiles still open. The rules the
 * tools, runs, logins and deletion keep are todos here until those phases land.
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
const aChange = fc.oneof(
  fc.record({ id: anId, change: fc.record({ mac: fc.constantFrom(...MACS), grant: fc.boolean() }) }),
  fc.record({ id: anId, change: fc.record({ home: fc.constantFrom("cloud", "sb-engineer", "sb-researcher", "sb-fin") }) })
);

const made = () => {
  const ky = world();

  for (const id of IDS) ky.specialists.create(id, NEW, "ky");

  return ky;
};

describe("R6 OneOwnerPerConversation: a profile lookup for a specialist's conversation never yields another owner", () => {
  it("is the specialist's for each conversation attached to it, and ky's for every other", () => {
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

  it("stays the specialist's once it is deleted, and then holds nothing", () => {
    fc.assert(
      fc.property(anId, aKind, fc.array(aChange, { maxLength: 4 }), (id, kind, changes) => {
        const { specialists } = made();
        specialists.attach("s1", id, kind);

        for (const { id: each, change } of changes) specialists.changeAccess(each, change);
        specialists.delete(id);

        expect(specialists.profileOf("s1")).toEqual({ owner: id, home: null, macs: [], tools: {} });
      })
    );
  });
});

describe("R5 OneOwnerPerRun: a profile is what it was when it was read", () => {
  it("keeps what it said while the user changes the owner's machines, and the next read says what they changed", () => {
    fc.assert(
      fc.property(anId, fc.array(aChange, { minLength: 1, maxLength: 8 }), (id, changes) => {
        const { specialists } = made();
        specialists.attach("s1", id, "home");
        const read = specialists.profileOf("s1");
        const copy = structuredClone(read);
        const macs = new Set<string>();
        let home = `sb-${id}`;

        for (const { id: each, change } of changes) {
          specialists.changeAccess(each, change);

          if (each !== id) continue;

          if ("home" in change) home = change.home;
          else if (change.grant) macs.add(change.mac);
          else macs.delete(change.mac);
        }

        expect(read).toEqual(copy);
        const now = specialists.profileOf("s1");
        expect(now.home?.id).toBe(home);
        expect([...now.macs].sort()).toEqual([...macs].sort());
      })
    );
  });
});

describe("R1 RunnerScope, as far as the profile goes: only the user grants", () => {
  it("gives a new specialist a sandbox of its own, never the default, and no Mac but the one the user named", () => {
    const { specialists, opened, sandboxes } = world();

    specialists.create("engineer", { ...NEW, machine: "mbp" }, "user");
    specialists.create("researcher", { ...NEW, machine: "mbp" }, "agent");

    expect(opened).toEqual(["engineer", "researcher"]);
    expect(sandboxes.filter((sandbox) => sandbox.isDefault).map((sandbox) => sandbox.id)).toEqual(["cloud"]);
    expect(specialists.profile("engineer")).toEqual({ owner: "engineer", home: { id: "sb-engineer", name: "engineer" }, macs: ["mbp"], tools: {} });
    expect(specialists.profile("researcher")).toEqual({ owner: "researcher", home: { id: "sb-researcher", name: "researcher" }, macs: [], tools: {} });
    expect(specialists.profile(KY)).toEqual({ owner: KY, home: { id: "cloud", name: "cloud" }, macs: [...MACS], tools: {} });
  });

  it("has no sandbox when it can't get one, rather than borrowing ky's", () => {
    const { specialists } = world();

    specialists.create("cloud-bot", NEW, "user");
    specialists.create("cloud", NEW, "user");

    expect(specialists.profile("cloud").home).toBeNull();
  });

  it("refuses a Mac that isn't paired, and a sandbox that isn't live", () => {
    const { specialists } = made();

    expect(() => specialists.changeAccess("engineer", { mac: "laptop", grant: true })).toThrow("laptop isn't one of your paired Macs.");
    expect(() => specialists.changeAccess("engineer", { home: "sb-gone" })).toThrow("No sandbox sb-gone.");
    expect(() => specialists.changeAccess("nobody", { mac: "mbp", grant: true })).toThrow("No specialist @nobody.");
  });

  it("lets nothing the specialist tool does give a specialist a Mac or another sandbox", () => {
    const anInput = fc.record({
      action: fc.constantFrom(...SpecialistAction.anyOf.map((each) => each.const)),
      id: fc.constantFrom(...IDS, "new-one"),
      description: fc.constant("Still builds things."),
      brief: fc.constant("Be brief."),
      machine: fc.constantFrom(...MACS, "cloud", "sb-fin")
    });

    fc.assert(
      fc.property(fc.array(anInput, { maxLength: 8 }), (inputs) => {
        const { specialists } = made();
        const before = specialists.access();

        for (const input of inputs) {
          try {
            MANAGE[input.action](specialists, input, "main");
          } catch {
            // Refused: the tool says why.
          }
        }

        const after = specialists.access();
        const { "new-one": added, ...kept } = after;

        expect(kept).toEqual(before);
        expect(added ?? { home: "sb-new-one", macs: [] }).toEqual({ home: "sb-new-one", macs: [] });
      })
    );
  });

  it.todo("R1: a machine task of a specialist's runs only on its home sandbox or a Mac it was granted (Phase 3A)");
  it.todo("R1: revoking a Mac stops the owner's runs on it (Phase 3A)");
});

describe("rows from before profiles", () => {
  /** A specialist as B wrote it: a row in ky_specialists, no profile. */
  function before(machine: string | null) {
    const { db, sandboxes, specialists } = world();
    db.prepare(`INSERT INTO ${SKILL_TABLES.specialists} (id, description, model, machine, session, created_at) VALUES ('old-bot', 'Was here first.', NULL, ?, NULL, 0)`).run(machine);
    sandboxes.push({ id: "sb-build", name: "build", isDefault: false });

    return specialists;
  }

  it("make a sandbox it named its home, a Mac it named its one Mac, and no hint ky's default sandbox", () => {
    expect(before("build").profile("old-bot")).toEqual({ owner: "old-bot", home: { id: "sb-build", name: "build" }, macs: [], tools: {} });
    expect(before("mbp").profile("old-bot")).toEqual({ owner: "old-bot", home: { id: "cloud", name: "cloud" }, macs: ["mbp"], tools: {} });
    expect(before(null).profile("old-bot")).toEqual({ owner: "old-bot", home: { id: "cloud", name: "cloud" }, macs: [], tools: {} });
  });

  it("keep what the hint gave when the user first changes it", () => {
    const specialists = before("mbp");

    specialists.changeAccess("old-bot", { mac: "studio", grant: true });

    expect(specialists.profile("old-bot").macs).toEqual(["mbp", "studio"]);
  });

  it("read a damaged profile as granting nothing", () => {
    const { db, specialists } = made();

    db.prepare(`UPDATE ${SKILL_TABLES.specialistProfiles} SET macs = 'not json' WHERE specialist = 'engineer'`).run();

    expect(specialists.profile("engineer")).toEqual({ owner: "engineer", home: null, macs: [], tools: {} });
  });
});

describe("rules later phases hold", () => {
  it.todo("R2 SessionMatchesVault: a live browser session holds only logins its owner has in the Vault; moving or removing one logs it out (Phase 3C)");
  it.todo("R3 DeleteCleans: a deleted specialist has no runs, sessions, logins, keys or Mac grants; its workflows go to ky, paused (Phase 4)");
  it.todo("R4 NoSilentFallback: a workflow whose Mac is offline waits and tells the user; it never runs on another machine (Phase 3B)");
  it.todo("R5 OneOwnerPerRun: a workflow's run keeps the profile it started with, even if the workflow is reassigned (Phase 3B)");
  it.todo("R6 ToolEnforced: the machine, browse, secret and executor tools refuse what the profile doesn't allow, whatever the prompt says (Phase 3)");
  it.todo("R7 NoLaundering: a change that outside content led to, directly or through a delegation, waits for the user's OK (Phase 1)");
});
