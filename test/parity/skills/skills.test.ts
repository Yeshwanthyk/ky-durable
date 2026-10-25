/**
 * Skills' parity: B's library and review log (src/skills/legacy/) and the port (src/skills/wiring.ts), each over
 * its own real SQLite, driven by the same runs: changes from every actor, through `apply` and the skill_manage
 * tool, opens, forks, the allowlist's verdicts, the staleness pass and the reads. After each step both answer
 * alike, hold the same rows and schema, and told their watchers the same writes.
 */
import type { Extension } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, vi } from "vitest";
import { REVIEW_ALLOWED, type ReviewKind, type SkillChange, SKILL_TABLES, TOOLS } from "../../../src/skills/contract";
import { Reviews as LegacyReviews, Skills as LegacySkills, skillsExtension as legacyExtension } from "../../../src/skills/legacy/skills";
import { skillsExtension } from "../../../src/skills/skills";
import { Reviews, Skills } from "../../../src/skills/wiring";
import { assertParity, type Clock, type Instance, type Json, type Parity } from "../kit";
import { blockOf, callTool, HOST, rowsOf, sqlOf, storageOf } from "./storage";

// Runs as long as the kit allows: at fast-check's default size most runs stop after a step or two, before a skill made early is changed.
fc.configureGlobal({ baseSize: "large" });

const DAY = 24 * 60 * 60 * 1000;

const START = Date.UTC(2026, 0, 1);

/** Conversation 1 is a chat with the user, 3 answers a peer; the rest are forks once `fork` records them. */
const CONVERSATIONS = ["1", "2", "3", "4", "5"];

const chat = (session: string) => session === "1";

const peer = (session: string) => session === "3";

/** Mostly names a run reuses, so a skill made early is changed later; now and then one that isn't a name. */
const aName = fc.oneof({ arbitrary: fc.constantFrom("tea", "kit-a"), weight: 7 }, { arbitrary: fc.constant("plan-trip"), weight: 2 }, { arbitrary: fc.constant("Bad Name"), weight: 1 });

const ACTORS = ["user", "ky", "agent", "review", "dream"];

const KINDS: ReviewKind[] = ["review", "dream", "episode", "look"];

const aBody = fc.oneof(
  { arbitrary: fc.constantFrom("Steep for three minutes.", "Steep for three minutes. Steep again."), weight: 4 },
  { arbitrary: fc.constantFrom("## Needs\n- city: Which city? (paris | rome)\n- budget: How much?\n\nBook it.", "## Members\n- tea\n- plan-trip\n- kit-a\n- gone"), weight: 4 },
  { arbitrary: fc.constantFrom("", "x".repeat(20_001)), weight: 1 }
);

const aDescription = fc.oneof({ arbitrary: fc.constantFrom("When the user wants tea.", "When planning a trip."), weight: 9 }, { arbitrary: fc.constantFrom("", " ", "d".repeat(201)), weight: 1 });

/** Why: now and then "refuse", which the watchers below refuse. */
const aReason = fc.oneof({ arbitrary: fc.constant("tidy"), weight: 9 }, { arbitrary: fc.constant("refuse"), weight: 1 });

const required: ("action" | "name")[] = ["action", "name"];

const optional = { requiredKeys: required };

/**
 * One change per action, with the fields it takes, so most land; now and then a field it doesn't take (a kind
 * after a create), one it lacks, or an action B doesn't know: the panel's change comes off a socket unchecked.
 */
const aChange: fc.Arbitrary<SkillChange> = fc.oneof(
  { arbitrary: fc.record({ action: fc.constant("create"), name: aName, description: aDescription, body: aBody, kind: fc.constantFrom("skill", "kit"), reason: aReason }, { requiredKeys: ["action", "name", "description", "body"] }), weight: 8 },
  { arbitrary: fc.record({ action: fc.constant("create"), name: aName, description: aDescription }), weight: 1 },
  { arbitrary: fc.record({ action: fc.constant("edit"), name: aName, description: aDescription, body: aBody, reason: aReason }, optional), weight: 3 },
  { arbitrary: fc.record({ action: fc.constant("patch"), name: aName, old: fc.constantFrom("", "three", "Steep", "nowhere"), new: fc.constantFrom("four", "") }, optional), weight: 2 },
  { arbitrary: fc.record({ action: fc.constant("archive"), name: aName, absorbed_into: fc.constantFrom("tea", "plan-trip", "kit-a", "gone"), reason: aReason }, optional), weight: 2 },
  { arbitrary: fc.record({ action: fc.constantFrom("restore", "pin", "unpin"), name: aName }), weight: 2 },
  { arbitrary: fc.record({ action: fc.constant("revert"), name: aName, version: fc.integer({ min: 0, max: 8 }) }, optional), weight: 2 },
  { arbitrary: fc.record({ action: fc.constant("answer"), name: aName, answers: fc.constantFrom<Record<string, string>>({ city: "paris" }, { city: " rome ", budget: "10" }, { budget: "" }, { colour: "red" }, {}) }, optional), weight: 2 },
  { arbitrary: fc.record({ action: fc.constant("edit"), name: aName, body: aBody, kind: fc.constantFrom("skill", "kit") }), weight: 1 },
  // SAFETY: "rename" is no action of SkillChange's; it is how a change B doesn't know reaches apply.
  { arbitrary: fc.record({ action: fc.constant("rename" as SkillChange["action"]), name: aName }), weight: 1 }
);

type Action =
  | { readonly manage: SkillChange; readonly actor: string; readonly conversation: string | null }
  | { readonly tool: SkillChange; readonly from: string }
  | { readonly view: string; readonly history: boolean; readonly from: string }
  | { readonly fork: string; readonly parent: string; readonly kind: ReviewKind; readonly upto?: number; readonly run?: string; readonly at?: number }
  | { readonly allow: string; readonly from: string }
  | { readonly stale: string; readonly ago?: number }
  | { readonly since: number; readonly limit: number; readonly except: string }
  | { readonly read: "index" | "all" | "archived" | "kind" | "run" | "reached" | "window"; readonly of: string; readonly kind: ReviewKind };

const aConversation = fc.constantFrom(...CONVERSATIONS);

const actions: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: fc.record({ manage: aChange, actor: fc.constantFrom(...ACTORS), conversation: fc.option(aConversation, { nil: null }) }), weight: 6 },
  { arbitrary: fc.record({ tool: aChange, from: aConversation }), weight: 3 },
  { arbitrary: fc.record({ view: aName, history: fc.boolean(), from: aConversation }), weight: 2 },
  {
    arbitrary: fc.record(
      { fork: aConversation, parent: fc.constantFrom("1", ""), kind: fc.constantFrom(...KINDS), upto: fc.integer({ min: 1, max: 20 }), run: fc.constantFrom("night-1"), at: fc.constantFrom(0) },
      { requiredKeys: ["fork", "parent", "kind"] }
    ),
    weight: 3
  },
  { arbitrary: fc.record({ allow: fc.constantFrom(...new Set(Object.values(REVIEW_ALLOWED).flat()), TOOLS.skillManage, "memory_write", "bash"), from: aConversation }), weight: 2 },
  { arbitrary: fc.record({ stale: fc.constantFrom("night-1", "night-2"), ago: fc.integer({ min: -DAY, max: 90 * DAY }) }, { requiredKeys: ["stale"] }), weight: 1 },
  { arbitrary: fc.record({ since: fc.integer({ min: START - DAY, max: START + 120 * DAY }), limit: fc.integer({ min: 0, max: 5 }), except: fc.constantFrom("", "dream", "user") }), weight: 1 },
  {
    arbitrary: fc.record({ read: fc.constantFrom("index", "all", "archived", "kind", "run", "reached", "window"), of: fc.constantFrom(...CONVERSATIONS, ""), kind: fc.constantFrom(...KINDS) }),
    weight: 2
  }
);

/** B's storage: a Durable Object's `sql`. */
type LegacyStorage = ConstructorParameters<typeof LegacySkills>[0];

/** B's side over `db`. */
function legacySql(db: DatabaseSync): LegacyStorage {
  // SAFETY: B's library and review log call exec and read toArray and one, nothing else of SqlStorage or its cursor.
  return { ...sqlOf(db), databaseSize: 0 } as LegacyStorage;
}

/** What a side is made of: B's or the port's library and log, and its extension over them. */
type Side = { readonly skills: Skills | LegacySkills; readonly reviews: Reviews | LegacyReviews; readonly extension: Extension };

/** The answer an action gets, or B's refusal: the words of what it threw. */
async function answer(work: () => Json | undefined | Promise<Json>): Promise<Json> {
  try {
    return (await work()) ?? null;
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

function instance({ skills, reviews, extension }: Side, db: DatabaseSync): Instance<Action> {
  const writes: Json[] = [];
  let changes = 0;

  skills.onWrite((write) => {
    if (write.reason === "refuse") throw new Error("The ledger refuses this write.");
    writes.push({ ...write });

    return (version) => writes.push({ landed: version });
  });
  skills.onChange(() => changes++);

  const read = ({ read: what, of, kind }: Extract<Action, { read: string }>): Json => {
    switch (what) {
      case "index":
        return skills.index();
      case "all":
        return [...skills.all()];
      case "archived":
        return [...skills.list("archived")];
      case "kind":
        return reviews.kind(of) ?? null;
      case "run":
        return reviews.run(of);
      case "reached":
        return reviews.reached(of, kind) ?? null;
      case "window":
        return reviews.window(of) ?? null;
    }
  };


  return {
    apply: async (action) => {
      if ("manage" in action) return answer(() => skills.apply(action.manage, action.actor, action.conversation));

      if ("tool" in action) return answer(() => callTool(extension, TOOLS.skillManage, action.tool, action.from));

      if ("view" in action) return answer(() => callTool(extension, TOOLS.skillView, { name: action.view, history: action.history }, action.from));

      if ("fork" in action) {
        // A second fork of one conversation breaks the table's key: SQLite's words, which aren't the contract's.
        if (reviews.has(action.fork)) return { skipped: true };
        const { fork, parent, kind, ...mark } = action;

        return answer(() => {
          reviews.add(fork, parent, kind, mark);

          return null;
        });
      }

      if ("allow" in action) return answer(() => blockOf(extension, action.allow, action.from));

      if ("stale" in action) return answer(() => [...skills.stale(action.stale, action.ago === undefined ? undefined : Date.now() + action.ago)]);

      if ("since" in action) return answer(() => [...skills.versionsSince(action.since, action.limit, action.except)]);

      return answer(() => read(action));
    },
    tables: async () => ({
      // The schema with its whitespace collapsed: indentation in a CREATE isn't part of the table.
      schema: db
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE '%skill%' ORDER BY name")
        .all()
        .map(({ type, name, sql }) => ({ type: String(type), name: String(name), sql: String(sql).replace(/\s+/g, " ") })),
      skills: rowsOf(db, SKILL_TABLES.skills),
      versions: rowsOf(db, SKILL_TABLES.skillVersions),
      reviews: rowsOf(db, SKILL_TABLES.skillReviews)
    }),
    effects: async () => ({ writes, changes }),
    dispose: async () => db.close()
  };
}

/** The kit's clock as Date.now, which B reads and the port's default Clock reads too. */
function useClock(clock: Clock): void {
  vi.spyOn(Date, "now").mockImplementation(() => clock.now());
}

afterEach(() => {
  vi.restoreAllMocks();
});

const skillsParity: Parity<Action> = {
  domain: "skills",
  actions,
  start: START,
  advances: fc.oneof(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: DAY, max: 70 * DAY })),
  legacy: async (clock) => {
    useClock(clock);
    const db = new DatabaseSync(":memory:");
    // Each wrapper over the one database is the same storage: none keeps state of its own.
    const skills = new LegacySkills(legacySql(db));
    const reviews = new LegacyReviews(legacySql(db));

    return instance({ skills, reviews, extension: legacyExtension(skills, reviews, HOST, chat, peer) }, db);
  },
  next: async () => {
    const db = new DatabaseSync(":memory:");
    const skills = new Skills(storageOf(db));
    const reviews = new Reviews(storageOf(db));

    return instance({ skills, reviews, extension: skillsExtension(skills, reviews, HOST, chat, peer) }, db);
  }
};

describe("skills parity", () => {
  it("answers, stores and tells its watchers what B does, step for step", async () => {
    await assertParity(skillsParity);
  });
});
