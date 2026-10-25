/**
 * Specialists' parity: B's Specialists (src/skills/legacy/) and the port (src/skills/wiring.ts), each over its own
 * real SQLite, driven by the same runs: creates and saves from every field's good and bad values, briefs edited,
 * conversations attached and looked up, and the reads. After each step both answer alike, hold the same rows
 * and schema, and told their listeners as often.
 */
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, vi } from "vitest";
import { type SessionKind, type SpecialistDraft, SKILL_TABLES } from "../../../src/skills/contract";
import { Specialists as LegacySpecialists } from "../../../src/skills/legacy/specialists";
import { Specialists } from "../../../src/skills/wiring";
import { assertParity, type Clock, type Instance, type Json, type Parity } from "../kit";
import { sqlOf, storageOf } from "./storage";

fc.configureGlobal({ baseSize: "large" });

const START = Date.UTC(2026, 0, 1);

/** Mostly ids a run reuses, so a specialist made early is saved and attached later; now and then one that isn't an id. */
const anId = fc.oneof({ arbitrary: fc.constantFrom("engineer", "re-search"), weight: 8 }, { arbitrary: fc.constantFrom("Bad Id", "-x", "a".repeat(33), "a".repeat(32)), weight: 1 });

/** A model in the order the settings write it, or in another: B stores the JSON as given and writes it back as it read it. */
const aModel = fc.constantFrom(
  { provider: "anthropic", modelId: "opus", thinkingLevel: "high" as const },
  { modelId: "gpt", provider: "openai", thinkingLevel: "off" as const },
  null
);

const aDraft: fc.Arbitrary<SpecialistDraft> = fc.record(
  {
    description: fc.oneof({ arbitrary: fc.constantFrom("Builds things.", "  Finds sources.  "), weight: 6 }, { arbitrary: fc.constantFrom("", " ", "two\nlines", "d".repeat(200), "d".repeat(199)), weight: 1 }),
    model: aModel,
    machine: fc.constantFrom("mac", "", null),
    brief: fc.oneof({ arbitrary: fc.constant("Be terse."), weight: 6 }, { arbitrary: fc.constantFrom("", "  "), weight: 1 })
  },
  { requiredKeys: [] }
);

const KINDS: SessionKind[] = ["home", "consult", "discuss", "group"];

const SESSIONS = ["s1", "s2", "s3"];

type Action =
  | { readonly create: string; readonly draft: SpecialistDraft; readonly actor: string; readonly conversation: string | null }
  | { readonly set: string; readonly draft: SpecialistDraft }
  | { readonly brief: string; readonly body: string; readonly actor: string }
  | { readonly attach: string; readonly id: string; readonly kind: SessionKind }
  | { readonly bySession: string }
  | { readonly read: "list" | "views" | "get" | "has"; readonly id: string };

const actions: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: fc.record({ create: anId, draft: aDraft, actor: fc.constantFrom("user", "agent"), conversation: fc.constantFrom("1", null) }), weight: 4 },
  { arbitrary: fc.record({ set: anId, draft: aDraft }), weight: 3 },
  { arbitrary: fc.record({ brief: anId, body: fc.constantFrom("Be kind.", ""), actor: fc.constantFrom("user", "agent") }), weight: 1 },
  { arbitrary: fc.record({ attach: fc.constantFrom(...SESSIONS), id: anId, kind: fc.constantFrom(...KINDS) }), weight: 3 },
  { arbitrary: fc.record({ bySession: fc.constantFrom(...SESSIONS, "none") }), weight: 2 },
  { arbitrary: fc.record({ read: fc.constantFrom("list", "views", "get", "has"), id: anId }), weight: 2 }
);

/** B's storage: a Durable Object's `sql`. */
type LegacyStorage = ConstructorParameters<typeof LegacySpecialists>[0];

function legacySql(db: DatabaseSync): LegacyStorage {
  // SAFETY: B's specialists and their briefs call exec and read toArray and one, nothing else of SqlStorage or its cursor.
  return { ...sqlOf(db), databaseSize: 0 } as LegacyStorage;
}

/** The answer an action gets, or B's refusal: the words of what it threw. */
function answer(work: () => Json | undefined): Json {
  try {
    return work() ?? null;
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

/** A table's rows, or none before its first write: a brief's table is made when a brief is first opened. */
function rowsOf(db: DatabaseSync, table: string): Json[] {
  if (db.prepare("SELECT name FROM sqlite_master WHERE name = ?").all(table).length === 0) return [];

  // SAFETY: these tables hold only numbers, strings and nulls.
  return db
    .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
    .all()
    .map((row) => ({ ...row }) as Json);
}

function instance(specialists: Specialists | LegacySpecialists, db: DatabaseSync): Instance<Action> {
  let changes = 0;
  specialists.onChange(() => changes++);

  const read = ({ read: what, id }: Extract<Action, { read: string }>): Json => {
    switch (what) {
      case "list":
        return specialists.list();
      case "views":
        return specialists.views();
      case "get":
        return specialists.get(id) ?? null;
      case "has":
        return specialists.has(id);
    }
  };

  return {
    apply: async (action) => {
      if ("create" in action) return answer(() => specialists.create(action.create, action.draft, action.actor, action.conversation));

      if ("set" in action) return answer(() => specialists.set(action.set, action.draft));

      if ("brief" in action) return answer(() => specialists.brief(action.brief).apply({ action: "edit", body: action.body }, action.actor));

      if ("attach" in action) return answer(() => specialists.attach(action.attach, action.id, action.kind));

      if ("bySession" in action) return answer(() => specialists.bySession(action.bySession) ?? null);

      return answer(() => read(action));
    },
    tables: async () => ({
      // The schema with its whitespace collapsed: indentation in a CREATE isn't part of the table.
      schema: db
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'ky_specialist%' OR name LIKE 'ky_soul%' ORDER BY name")
        .all()
        .map(({ type, name, sql }) => ({ type: String(type), name: String(name), sql: String(sql).replace(/\s+/g, " ") })),
      specialists: rowsOf(db, SKILL_TABLES.specialists),
      sessions: rowsOf(db, SKILL_TABLES.specialistSessions),
      briefs: rowsOf(db, "ky_soul_versions")
    }),
    effects: async () => ({ changes }),
    dispose: async () => db.close()
  };
}

/** The kit's clock as Date.now, which B and the briefs read and the port's default Clock reads too. */
function useClock(clock: Clock): void {
  vi.spyOn(Date, "now").mockImplementation(() => clock.now());
}

afterEach(() => {
  vi.restoreAllMocks();
});

const specialistsParity: Parity<Action> = {
  domain: "skills",
  actions,
  start: START,
  advances: fc.integer({ min: 0, max: 60_000 }),
  legacy: async (clock) => {
    useClock(clock);
    const db = new DatabaseSync(":memory:");

    return instance(new LegacySpecialists(legacySql(db)), db);
  },
  next: async () => {
    const db = new DatabaseSync(":memory:");

    return instance(new Specialists(storageOf(db)), db);
  }
};

describe("specialists parity", () => {
  it("answers, stores and tells its listeners what B does, step for step", async () => {
    await assertParity(specialistsParity);
  });
});
