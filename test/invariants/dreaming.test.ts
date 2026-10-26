import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import fc from "fast-check";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sql } from "../../src/core/sql";
import {
  anticipationRow,
  countOf,
  datesOf,
  DREAM_MEMORY_TOOLS,
  DREAMING_TABLES,
  markOf,
  MEMORY_WRITE_TOOLS,
  memoryRow,
  NO_MARK,
  type SoulChange,
  summaryOf
} from "../../src/dreaming/contract";
import { DreamLedger, Ledger } from "../../src/dreaming/ledger";
import { type Compressor, Memory } from "../../src/dreaming/memory";
import { Soul } from "../../src/dreaming/soul";
import { type Versioned, Versions } from "../../src/dreaming/versioned";
import type { SkillChange } from "../../src/skills/contract";
import { Reviews, Skills, Specialists } from "../../src/skills/wiring";
import { budget } from "../parity/kit";
import { storageOf, StoredRow } from "../parity/skills/storage";

const FOLDER = path.join(import.meta.dirname, "../../src/dreaming");

const sources = readdirSync(FOLDER)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => readFileSync(path.join(FOLDER, file), "utf8"));

describe("a damaged row decodes to its default", () => {
  const damaged: ReadonlyArray<Readonly<Record<string, SqlStorageValue>> | undefined> = [undefined, {}, { memories: "abc", at: 1 }, { id: "7", date: null, text: 3 }, { text: new ArrayBuffer(2) }];

  it.each(damaged)("the dream's mark from %o is the beginning", (row) => {
    expect(markOf(row)).toEqual(NO_MARK);
  });

  it("the dream's mark is read as stored when it is whole", () => {
    expect(markOf({ memories: 12, at: 1_700_000_000_000 })).toEqual({ memories: 12, at: 1_700_000_000_000 });
    expect(markOf({ memories: -1, at: 0 })).toEqual(NO_MARK);
  });

  it.each(damaged)("a memory from %o is skipped", (row) => {
    expect(memoryRow(row)).toBeUndefined();
  });

  it.each(damaged)("an anticipation from %o is skipped", (row) => {
    expect(anticipationRow(row)).toBeUndefined();
  });

  const anticipation = {
    id: 1, created_at: 1, created_by: "dream", kind: "open_loop", text: "Reply to Sam", evidence: '{"messages":[4],"memories":[0]}',
    prepared: null, window_from: null, window_to: null, status: "open", pinned: 1, absorbed_into: null, closed_at: null
  };

  it("an anticipation with damaged evidence, an unknown status or creator is skipped, and a whole one decodes", () => {
    expect(anticipationRow({ ...anticipation, evidence: "[4" })).toBeUndefined();
    expect(anticipationRow({ ...anticipation, evidence: '{"messages":["4"],"memories":[]}' })).toBeUndefined();
    expect(anticipationRow({ ...anticipation, status: "snoozed" })).toBeUndefined();
    expect(anticipationRow({ ...anticipation, created_by: "agent" })).toBeUndefined();
    expect(anticipationRow(anticipation)).toEqual({ ...anticipation, evidence: { messages: [4], memories: [0] }, pinned: true });
  });

  it.each(damaged)("the counts, summaries, dates and columns from %o fall back", (row) => {
    expect(countOf(row)).toBe(0);
    expect(summaryOf(row)).toBeUndefined();
    expect(datesOf(row)).toEqual({ from: "", to: "" });
  });

  it("whole rows decode as stored", () => {
    expect(memoryRow({ id: 0, date: "2026-10-14", text: "the user likes green tea" })).toEqual({ id: 0, date: "2026-10-14", text: "the user likes green tea" });
    expect(countOf({ n: 3 })).toBe(3);
    expect(summaryOf({ text: "a summary" })).toBe("a summary");
  });
});

describe("the tables the contract names", () => {
  const created = sources.flatMap((source) => [...source.matchAll(/CREATE TABLE (IF NOT EXISTS )?(\w+)/g)].map((match) => ({ table: match[2], guarded: match[1] !== undefined })));

  it("are exactly the ones the domain creates", () => {
    expect(created.map((each) => each.table).sort()).toEqual(Object.values(DREAMING_TABLES).sort());
  });

  it("are created only if they don't exist, and never dropped on start", () => {
    expect(created.filter((each) => !each.guarded)).toEqual([]);
    expect(sources.filter((source) => /DROP\s+TABLE/i.test(source))).toEqual([]);
  });
});

describe("the allowlists", () => {
  it("name each tool once, and the writes are among what a dream may call", () => {
    expect(new Set(DREAM_MEMORY_TOOLS).size).toBe(DREAM_MEMORY_TOOLS.length);
    expect(MEMORY_WRITE_TOOLS.filter((tool) => !DREAM_MEMORY_TOOLS.includes(tool))).toEqual([]);
  });
});

const CAP = 20_000;

const START = Date.UTC(2026, 0, 1);

const HOUR = 60 * 60 * 1000;

type File = { readonly key: string; readonly label: string; readonly template?: string };

const FILES: readonly File[] = [
  { key: "soul", label: "SOUL.md", template: "# SOUL.md\nBe kind with tea." },
  { key: "specialist:eng", label: "@eng's brief" }
];

type Kept = { key: string; version: number; action: string; actor: string; conversation: string | null; body: string; created_at: number };

function occurrences(text: string, part: string): number {
  let count = 0;

  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) count++;

  return count;
}

type Outcome = { readonly body: string } | { readonly refused: string };

function patchOf(label: string, was: string, old: string, replacement: string): Outcome {
  const count = old === "" ? 0 : occurrences(was, old);

  if (count === 0) return { refused: `The text to replace is not in ${label}.` };

  if (count > 1) return { refused: `The text to replace appears ${count} times in ${label}; quote more of it.` };
  const at = was.indexOf(old);

  return { body: was.slice(0, at) + replacement + was.slice(at + old.length) };
}

function proposed(versions: readonly Kept[], label: string, change: SoulChange, was: string): Outcome {
  if (change.action === "edit") return change.body === undefined ? { refused: "edit needs a body." } : { body: change.body };

  if (change.action === "patch") return change.old === undefined || change.new === undefined ? { refused: "patch needs old and new." } : patchOf(label, was, change.old, change.new);

  if (change.version === undefined) return { refused: "revert needs a version." };
  const found = versions.find((each) => each.version === change.version);

  return found === undefined ? { refused: `${label} has no version ${change.version}.` } : { body: found.body };
}

function unkept(label: string, body: string, was: string): string | undefined {
  if (body.trim() === "") return `${label} cannot be empty.`;

  if (body.length > CAP) return `${label} would be ${body.length} characters; keep it under ${CAP}.`;

  return body === was ? `${label} is unchanged.` : undefined;
}

function attempt(versions: readonly Kept[], label: string, change: SoulChange, last: string | undefined): Outcome {
  if (last === undefined && change.action !== "edit") return { refused: `${label} does not exist.` };
  const was = last ?? "";
  const outcome = proposed(versions, label, change, was);
  const refused = "refused" in outcome ? outcome.refused : unkept(label, outcome.body, was);

  return refused === undefined ? outcome : { refused };
}

function expected(kept: Kept[], file: File, change: SoulChange, actor: string, conversation: string | null, now: number): string {
  const mine = () => kept.filter((each) => each.key === file.key);

  const add = (action: string, by: string, from: string | null, body: string) => {
    const version = mine().length + 1;
    kept.push({ key: file.key, version, action, actor: by, conversation: from, body, created_at: now });

    return version;
  };

  if (mine().length === 0 && file.template !== undefined) add("create", "template", null, file.template);
  const last = mine().at(-1);
  const outcome = attempt(mine(), file.label, change, last?.body);

  if ("refused" in outcome) return outcome.refused;
  const action = last ? change.action : "create";

  return `Saved ${action} of ${file.label} (version ${add(action, actor, conversation, outcome.body)}).`;
}

type Step = { readonly file: number; readonly change: SoulChange; readonly actor: string; readonly conversation: string | null; readonly advance: number };

const plain = Schema.decodeUnknownSync(StoredRow);

function rowsOf(db: DatabaseSync, query: string, ...bindings: SQLInputValue[]) {
  return db
    .prepare(query)
    .all(...bindings)
    .map((row) => plain(row));
}

async function versionsHold(steps: readonly Step[]): Promise<string[]> {
  const db = new DatabaseSync(":memory:");
  const layer = Layer.mergeAll(Versions.layer, TestClock.layer()).pipe(Layer.provide(Sql.layer(storageOf(db))));
  const kept: Kept[] = [];
  let now = START;

  const answers = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const versions = yield* Versions;
        const said: string[] = [];

        for (const { file, change, actor, conversation, advance } of steps) {
          now += advance;
          yield* TestClock.setTime(now);
          const target = FILES[file] ?? FILES[0]!;
          const answer = yield* Effect.catch(versions.apply({ ...target, listeners: new Set() }, change, actor, conversation), (refusal) => Effect.succeed(refusal.refusal));
          expect(answer).toBe(expected(kept, target, change, actor, conversation, now));
          said.push(answer);
        }

        return said;
      }),
      layer
    )
  );

  expect(rowsOf(db, "SELECT key, version, action, actor, conversation, body, created_at FROM ky_soul_versions ORDER BY id")).toEqual(kept);
  db.close();

  return answers;
}

const aBody = fc.constantFrom("tea", "tea tea", "green tea", "tea tea tea", "", "  ", "x".repeat(CAP - 1), "x".repeat(CAP), "x".repeat(CAP + 1));

const anOld = fc.constantFrom("tea", "green", "coffee", "");

const aNew = fc.constantFrom("mint", "tea", "", "x".repeat(CAP));

const aChange: fc.Arbitrary<SoulChange> = fc.oneof(
  fc.record({ action: fc.constant("edit" as const), body: aBody }, { requiredKeys: ["action"] }),
  fc.record({ action: fc.constant("patch" as const), old: anOld, new: aNew }, { requiredKeys: ["action"] }),
  fc.record({ action: fc.constant("revert" as const), version: fc.integer({ min: 0, max: 5 }) }, { requiredKeys: ["action"] })
);

const aStep = (change: fc.Arbitrary<SoulChange>, file: fc.Arbitrary<number> = fc.constantFrom(0, 1)): fc.Arbitrary<Step> =>
  fc.record({ file, change, actor: fc.constantFrom("user", "agent", "dream"), conversation: fc.constantFrom(null, "1"), advance: fc.integer({ min: 0, max: 90_000 }) });

const rules: ReadonlyArray<readonly [string, fc.Arbitrary<readonly Step[]>, RegExp]> = [
  ["a patch or revert of a file with no version is refused, and an edit creates it", fc.tuple(aStep(aChange, fc.constant(1))).map((steps) => [...steps]), /does not exist\.$/],
  [
    "an edit, patch or revert missing what it needs is refused",
    fc.tuple(aStep(aChange), aStep(fc.constantFrom<SoulChange>({ action: "edit" }, { action: "patch", old: "tea" }, { action: "patch", new: "tea" }, { action: "revert" }))).map((steps) => [...steps]),
    /needs/
  ],
  ["a body that is empty is refused", fc.tuple(aStep(aChange), aStep(fc.constantFrom<SoulChange>({ action: "edit", body: "" }, { action: "edit", body: " \n " }, { action: "patch", old: "tea", new: "" }))).map((steps) => [...steps]), /cannot be empty/],
  ["a body over the cap is refused, and one at the cap is kept", fc.array(aStep(fc.record({ action: fc.constant("edit" as const), body: fc.constantFrom("x".repeat(CAP), "x".repeat(CAP + 1), "y".repeat(CAP - 1)) })), { minLength: 1, maxLength: 4 }), /keep it under 20000/],
  ["a patch whose text is not in the file is refused", fc.tuple(aStep(aChange), aStep(fc.record({ action: fc.constant("patch" as const), old: fc.constantFrom("coffee", ""), new: aNew }))).map((steps) => [...steps]), /is not in/],
  [
    "a patch whose text appears more than once is refused, with the count",
    fc.tuple(aStep(fc.record({ action: fc.constant("edit" as const), body: fc.constantFrom("tea tea", "tea tea tea", "tea") })), aStep(fc.record({ action: fc.constant("patch" as const), old: fc.constant("tea"), new: aNew }))).map((steps) => [...steps]),
    /appears \d+ times/
  ],
  ["a revert to a version the file never had is refused", fc.array(aStep(aChange), { minLength: 1, maxLength: 6 }).map((steps) => [...steps, { file: 0, change: { action: "revert" as const, version: 9 }, actor: "user", conversation: null, advance: 1 }]), /has no version/],
  ["versions are numbered per file and stamped with the Clock's time", fc.array(aStep(aChange), { minLength: 2, maxLength: 12 }), /^Saved/]
];

describe("SOUL.md and the specialists' briefs", () => {
  it.each(rules)("%s", async (_name, steps, words) => {
    let seen = 0;
    await fc.assert(
      fc.asyncProperty(steps, async (generated) => {
        seen += (await versionsHold(generated)).filter((answer) => words.test(answer)).length;
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
    expect(seen).toBeGreaterThan(0);
  });

  it("SOUL.md tells its listeners once for each version it saves, and a brief tells the specialists'", () => {
    fc.assert(
      fc.property(fc.array(aChange, { minLength: 1, maxLength: 8 }), fc.array(aChange, { maxLength: 8 }), (souls, briefs) => {
        const db = new DatabaseSync(":memory:");
        const soul = new Soul(storageOf(db));
        const specialists = new Specialists(storageOf(db));
        const heard = { soul: 0, brief: 0 };
        soul.onChange(() => heard.soul++);
        specialists.onChange(() => heard.brief++);
        const saved = (file: Versioned, changes: SoulChange[]) => changes.filter((change) => answerOf(() => file.apply(change, "user")).startsWith("Saved")).length;
        expect({ soul: saved(soul, souls), brief: saved(specialists.brief("eng"), briefs) }).toEqual(heard);
        db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("a damaged version row is skipped, and the last whole one is current", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("tea", "mint", "green tea"), { minLength: 1, maxLength: 4 }), fc.constantFrom<Record<string, SQLInputValue>>({ created_at: "soon" }, { version: "v" }, { version: 2.5 }), (bodies, damage) => {
        const db = new DatabaseSync(":memory:");
        const soul = new Soul(storageOf(db));
        bodies.forEach((body, at) => soul.apply({ action: "edit", body: `${body} ${at}` }, "user"));
        const whole = soul.history();
        const row = { key: "soul", version: whole.length + 1, action: "edit", actor: "user", conversation: null, body: "damaged", created_at: 1, ...damage };
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ky_soul_versions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
        expect(soul.history()).toEqual(whole);
        expect(soul.current()).toEqual(whole[0]);
        db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

const compressor: Compressor = () => Promise.reject(new Error("nothing compresses here"));

type Storage = ConstructorParameters<typeof Skills>[0];

type World = { readonly db: DatabaseSync; readonly skills: Skills; readonly memory: Memory; readonly reviews: Reviews };

const memoryOver = ({ sql }: Storage) => new Memory(sql, compressor);

function world(): World {
  const db = new DatabaseSync(":memory:");
  const skills = new Skills(storageOf(db));
  const reviews = new Reviews(storageOf(db));
  const memory = memoryOver(storageOf(db));
  reviews.add("c1", "chat", "dream", { run: "night-1" });
  reviews.add("c2", "chat", "review");
  reviews.add("c3", "chat", "dream", { run: "night-2" });

  return { db, skills, memory, reviews };
}

const summarize = ({ db }: World, block: string, text: string) => {
  const [lo, hi] = block.split("-").map(Number);
  db.prepare("INSERT OR REPLACE INTO memo_tree (lo, hi, text) VALUES (?, ?, ?)").run(lo ?? 0, (hi ?? 0) + 1, text);
};

function answerOf(work: () => string): string {
  try {
    return work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const refusal = (work: () => void): string => {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("expected a refusal");
};

const ledgerRows = ({ db }: World) => rowsOf(db, "SELECT * FROM ky_dream_ledger ORDER BY id");

const aName = fc.constantFrom("tea", "plan-trip", "ship");

const create = (name: string): SkillChange => ({ action: "create", name, description: `How to ${name}.`, body: `Steps for ${name}.` });

const edit = (name: string, n: number): SkillChange => ({ action: "edit", name, body: `Steps for ${name}, take ${n}.` });

describe("the dream's ledger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a run's second change to one skill or summary is refused until the first is undone, and another run may make it", () => {
    fc.assert(
      fc.property(aName, fc.constantFrom("edit", "revert"), fc.constantFrom("skill", "memory"), (name, first, kind) => {
        const here = world();
        const ledger = new DreamLedger(storageOf(here.db), here);

        if (kind === "skill") {
          here.skills.apply(create(name), "user");
          here.skills.apply(first === "edit" ? edit(name, 1) : { action: "revert", name, version: 1 }, "dream", "c1");
          const done = first === "edit" ? "edit" : "revert";
          expect(refusal(() => here.skills.apply(edit(name, 2), "dream", "c1"))).toBe(`This run already changed ${name} (${done}); one change per skill a run, so each can be undone on its own.`);
        } else {
          summarize(here, "0-15", `${name} summary`);
          here.memory.forget("0-15", "c1");
          summarize(here, "0-15", `${name} summary again`);
          expect(refusal(() => here.memory.forget("0-15", "c1"))).toBe(`This run already changed 0-15 (forget); one change per summary a run, so each can be undone on its own.`);
        }

        const [firstRow] = ledger.lastNight();
        ledger.undo(Number(firstRow?.id));

        const again = (conversation: string, at: number) => () =>
          kind === "skill" ? here.skills.apply(edit(name, at), "dream", conversation) : (summarize(here, "0-15", `${name} ${at}`), here.memory.forget("0-15", conversation));

        expect(again("c1", 4)).not.toThrow();
        expect(again("c3", 5)).not.toThrow();
        here.db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("an undo of a change the ledger never had, or of one a restore damaged, is refused", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.constantFrom<Record<string, SQLInputValue>>({ kind: "soul" }, { at: "yesterday" }, { after: "five" }), (id, damage) => {
        const here = world();
        const ledger = new DreamLedger(storageOf(here.db), here);
        expect(refusal(() => ledger.undo(id))).toBe(`No dream change ${id}.`);
        const row = { id, run: "night-1", actor: "dream", kind: "skill", action: "edit", target: "tea", before: 1, reason: null, absorbed_into: null, after: 2, at: START, undone_at: null, ...damage };
        const columns = Object.keys(row);
        here.db.prepare(`INSERT INTO ky_dream_ledger (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
        expect(ledger.lastNight()).toEqual([]);
        expect(refusal(() => ledger.undo(id))).toBe(`No dream change ${id}.`);
        here.db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("a change undone once is refused a second undo, in its actor's name", () => {
    fc.assert(
      fc.property(aName, fc.constantFrom("dream", "review", null), (name, actor) => {
        const here = world();
        const ledger = new DreamLedger(storageOf(here.db), here);
        here.skills.apply(create(name), "user");
        here.skills.apply(edit(name, 1), actor ?? "dream", actor === "review" ? "c2" : "c1");

        if (actor === null) here.db.prepare("UPDATE ky_dream_ledger SET actor = NULL").run();
        const [row] = ledgerRows(here);
        const id = Number(row?.id);
        ledger.undo(id);
        expect(refusal(() => ledger.undo(id))).toBe(`The ${actor ?? "dream"}'s edit of ${name} is already undone.`);
        here.db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("an undo of a skill changed since is refused, naming the newer version", () => {
    fc.assert(
      fc.property(aName, fc.constantFrom("user", "agent"), fc.constantFrom("edit", "archive"), (name, by, later) => {
        const here = world();
        const ledger = new DreamLedger(storageOf(here.db), here);
        here.skills.apply(create(name), "user");
        here.skills.apply(edit(name, 1), "dream", "c1");
        here.skills.apply(later === "edit" ? edit(name, 2) : { action: "archive", name }, by);
        const [newest] = here.skills.history(name);
        const [row] = ledger.lastNight();
        expect(refusal(() => ledger.undo(Number(row?.id)))).toBe(
          `${name} changed after this edit (version ${newest?.id}, ${later} by ${by}), so undo would lose that; revert it from its history instead.`
        );
        here.db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("an undo of a skill pinned since is refused until it is unpinned", () => {
    fc.assert(
      fc.property(aName, fc.constantFrom("create", "edit"), (name, action) => {
        const here = world();
        const ledger = new DreamLedger(storageOf(here.db), here);

        if (action === "create") here.skills.apply(create(name), "dream", "c1");
        else {
          here.skills.apply(create(name), "user");
          here.skills.apply(edit(name, 1), "dream", "c1");
        }

        here.skills.apply({ action: "pin", name }, "user");
        const [row] = ledger.lastNight();
        expect(refusal(() => ledger.undo(Number(row?.id)))).toBe(`${name} was pinned since; unpin it first to undo this ${action}.`);
        here.skills.apply({ action: "unpin", name }, "user");
        expect(() => ledger.undo(Number(row?.id))).not.toThrow();
        here.db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("each change a background run makes is stored with its run, actor, what it replaced and what it made", () => {
    fc.assert(
      fc.property(aName, fc.integer({ min: 0, max: 10_000 }), fc.constantFrom("dream", "review"), (name, at, actor) => {
        vi.spyOn(Date, "now").mockReturnValue(START + at);
        const here = world();
        new DreamLedger(storageOf(here.db), here);
        const conversation = actor === "dream" ? "c1" : "c2";
        const run = actor === "dream" ? "night-1" : "c2";
        here.skills.apply(create("other"), "agent");
        here.skills.apply(create(name), actor, conversation);
        here.skills.apply({ action: "archive", name: "other", absorbed_into: name, reason: "merged" }, actor, conversation);
        summarize(here, "0-15", "the user likes tea");
        here.memory.forget("0-15", conversation);
        const versions = (skill: string) => here.skills.history(skill).map((each) => each.id);
        const row = { run, actor, at: START + at, undone_at: null };
        expect(ledgerRows(here)).toEqual([
          { id: 1, ...row, kind: "skill", action: "create", target: name, before: null, reason: null, absorbed_into: null, after: versions(name)[0] },
          { id: 2, ...row, kind: "skill", action: "archive", target: "other", before: versions("other")[1], reason: "merged", absorbed_into: name, after: versions("other")[0] },
          { id: 3, ...row, kind: "memory", action: "forget", target: "0-15", before: "the user likes tea", reason: null, absorbed_into: null, after: null }
        ]);
        here.db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  const ledgerOver = (here: World) => Layer.mergeAll(Ledger.layer(here), TestClock.layer()).pipe(Layer.provide(Sql.layer(storageOf(here.db))));

  const atRows = (here: World) => rowsOf(here.db, "SELECT run, at, undone_at FROM ky_dream_ledger ORDER BY id");

  it("last night is the dream's changes in the twelve hours up to its latest, oldest first", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ gap: fc.oneof(fc.integer({ min: 0, max: 13 * HOUR }), fc.constantFrom(12 * HOUR - 1, 12 * HOUR, 12 * HOUR + 1)), conversation: fc.constantFrom("c1", "c2", "c3") }), { minLength: 1, maxLength: 8 }),
        async (steps) => {
          const here = world();
          let at = START;

          const made = steps.map(({ gap, conversation }, index) => {
            at += gap;

            return { id: index + 1, at, dream: conversation !== "c2", conversation, block: `${index}-${index}` };
          });

          const night = await Effect.runPromise(
            Effect.provide(
              Effect.gen(function* () {
                const ledger = yield* Ledger;

                for (const { at: when, conversation, block } of made) {
                  yield* TestClock.setTime(when);
                  yield* ledger.forget({ block, text: "a summary", conversation });
                }

                return yield* ledger.lastNight;
              }),
              ledgerOver(here)
            )
          );

          const dreams = made.filter((each) => each.dream);
          const latest = Math.max(...dreams.map((each) => each.at));
          expect(night.map((row) => row.id)).toEqual(dreams.filter((each) => each.at > latest - 12 * HOUR).map((each) => each.id));
          here.db.close();
        }
      ),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("a skill change is stamped with the Clock's time, and one with no run is named for it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (at) => {
        const here = world();
        await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(START + at);
              const ledger = yield* Ledger;
              yield* ledger.skillWrite({ name: "tea", action: "create", actor: "dream", conversation: null, run: null, before: null, absorbed_into: null, reason: null });
              yield* ledger.skillWrite({ name: "tea", action: "edit", actor: "dream", conversation: "c1", run: null, before: 1, absorbed_into: null, reason: null });
            }),
            ledgerOver(here)
          )
        );
        expect(atRows(here)).toEqual([
          { run: `dream-${START + at}`, at: START + at, undone_at: null },
          { run: "night-1", at: START + at, undone_at: null }
        ]);
        here.db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("a forget is stamped with the Clock's time", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (at) => {
        const here = world();
        await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              yield* TestClock.setTime(START + at);
              yield* (yield* Ledger).forget({ block: "0-15", text: "a summary", conversation: "c2" });
            }),
            ledgerOver(here)
          )
        );
        expect(atRows(here)).toEqual([{ run: "c2", at: START + at, undone_at: null }]);
        here.db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("an undo is stamped with the Clock's time", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), async (at, later) => {
        const here = world();
        await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const ledger = yield* Ledger;
              yield* TestClock.setTime(START + at);
              yield* ledger.forget({ block: "0-15", text: "a summary", conversation: "c2" });
              yield* TestClock.setTime(START + at + later);
              yield* Effect.orDie(ledger.undo(1));
            }),
            ledgerOver(here)
          )
        );
        expect(atRows(here)).toEqual([{ run: "c2", at: START + at, undone_at: START + at + later }]);
        here.db.close();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});
