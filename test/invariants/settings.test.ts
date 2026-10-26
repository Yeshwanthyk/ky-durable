import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type ModelChoice, nearestLevel } from "../../src/settings/contract";
import { Settings } from "../../src/settings/wiring";
import { budget, type Json } from "../parity/kit";
import { CATALOG, levelsOf, ORDER, PURPOSES, type PurposeName, validOf } from "../parity/settings/reads";
import { storageOf } from "../parity/skills/storage";

const PROVIDERS = ["workers-ai", "vibeproxy", "gone"];

const MODELS = [...[...CATALOG.values()].flatMap((models) => [...models.keys()]), "retired"];

const aPurpose = fc.constantFrom(...PURPOSES);

const aLevel = fc.constantFrom(...ORDER);

const aChoice: fc.Arbitrary<ModelChoice> = fc.record({
  provider: fc.constantFrom(...PROVIDERS),
  modelId: fc.constantFrom(...MODELS),
  thinkingLevel: aLevel
});

const aRaw = fc.oneof(
  aChoice.map((choice) => JSON.stringify(choice)),
  aChoice.map(({ provider, modelId, thinkingLevel }) => JSON.stringify({ thinkingLevel, modelId, provider })),
  aChoice.map((choice) => JSON.stringify({ ...choice, extra: 1 })),
  fc.constantFrom(
    "not json",
    "null",
    '"text"',
    "[]",
    '{"provider":1,"modelId":"kimi","thinkingLevel":"high"}',
    '{"provider":"workers-ai","modelId":"kimi"}',
    '{"provider":"workers-ai","modelId":"kimi","thinkingLevel":"turbo"}'
  )
);

const shown = (choice: ModelChoice | undefined): Json =>
  choice
    ? {
        provider: choice.provider,
        modelId: choice.modelId,
        thinkingLevel: choice.thinkingLevel
      }
    : null;

function fresh() {
  const db = new DatabaseSync(":memory:");
  const state = { connected: new Set<string>(PROVIDERS) };
  const heard: Json[] = [];

  const settings = new Settings(storageOf(db), (choice) => validOf(nearestLevel, state.connected)(choice));

  settings.onChange((purpose, choice) => heard.push({ purpose, choice: shown(choice) }));

  const rows = () =>
    db
      .prepare("SELECT purpose, value FROM ky_purposes ORDER BY purpose")
      .all()
      .map((row) => ({
        purpose: String(row.purpose),
        value: String(row.value)
      }));

  return { db, state, heard, settings, rows };
}

const RUNS = { numRuns: budget().numRuns * 4, seed: budget().seed };

const distance = (a: ModelThinkingLevel, b: ModelThinkingLevel) => Math.abs(ORDER.indexOf(a) - ORDER.indexOf(b));

function nearestOf(levels: readonly ModelThinkingLevel[], wanted: ModelThinkingLevel, got: ModelThinkingLevel) {
  if (levels.length === 0) return got === "off";

  return levels.includes(got) && levels.every((level) => distance(got, wanted) <= distance(level, wanted));
}

const Written = Schema.fromJsonString(
  Schema.Struct({
    provider: Schema.String,
    modelId: Schema.String,
    thinkingLevel: Schema.Literals(ORDER)
  })
);

const parsed = (raw: string) => Option.getOrUndefined(Schema.decodeUnknownOption(Written)(raw));

const keysOf = (raw: string) => Object.keys(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(raw)).sort();

describe("a purpose's model", () => {
  it("refuses a model the connected providers don't offer in B's words, storing nothing and telling no one", () => {
    fc.assert(
      fc.property(aPurpose, aChoice, fc.subarray(PROVIDERS), (purpose, choice, connected) => {
        fc.pre(levelsOf(choice, new Set(connected)) === undefined);
        const { db, state, heard, settings, rows } = fresh();

        state.connected = new Set(connected);
        expect(() => settings.set(purpose, choice)).toThrow(new Error(`${choice.provider}/${choice.modelId} is not available.`));
        expect(rows()).toEqual([]);
        expect(heard).toEqual([]);
        db.close();
      }),
      RUNS
    );
  });

  it("stores, returns and tells a level the model has, the one asked or the nearest to it", () => {
    fc.assert(
      fc.property(aPurpose, aChoice, (purpose, choice) => {
        const levels = levelsOf(choice, new Set(PROVIDERS));

        fc.pre(levels !== undefined);
        const { db, heard, settings, rows } = fresh();
        const kept = settings.set(purpose, choice);
        const [row] = rows();
        const stored = row && parsed(row.value);

        expect(nearestOf(levels ?? [], choice.thinkingLevel, kept.thinkingLevel)).toBe(true);
        expect(stored).toEqual({
          provider: choice.provider,
          modelId: choice.modelId,
          thinkingLevel: kept.thinkingLevel
        });
        expect(row?.purpose).toBe(purpose);
        expect(heard).toEqual([{ purpose, choice: shown(kept) }]);
        db.close();
      }),
      RUNS
    );
  });

  it("keeps each purpose's own last choice", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(aPurpose, aChoice), { maxLength: 12 }), (sets) => {
        const { db, settings } = fresh();
        const last = new Map<PurposeName, ModelChoice>();

        for (const [purpose, choice] of sets) {
          try {
            last.set(purpose, settings.set(purpose, choice));
          } catch {
            continue;
          }
        }

        for (const purpose of PURPOSES) expect(settings.get(purpose)).toEqual(last.get(purpose));
        db.close();
      }),
      RUNS
    );
  });

  it("reads a damaged stored choice, or one whose model is gone, as none", () => {
    fc.assert(
      fc.property(aPurpose, fc.oneof(aRaw, fc.string(), fc.json()), fc.subarray(PROVIDERS), (purpose, raw, connected) => {
        const { db, state, settings } = fresh();

        db.prepare("INSERT INTO ky_purposes (purpose, value) VALUES (?, ?)").run(purpose, raw);
        state.connected = new Set(connected);
        const stored = parsed(raw);
        const levels = stored && levelsOf(stored, state.connected);
        const read = settings.get(purpose);

        if (!stored || !levels) expect(read).toBeUndefined();
        else {
          expect(read && { provider: read.provider, modelId: read.modelId }).toEqual({ provider: stored.provider, modelId: stored.modelId });
          expect(read && nearestOf(levels, stored.thinkingLevel, read.thinkingLevel)).toBe(true);
        }

        for (const other of PURPOSES.filter((each) => each !== purpose)) expect(settings.get(other)).toBeUndefined();
        db.close();
      }),
      RUNS
    );
  });

  it("keeps only a choice's provider, model and level, whatever else it carries", () => {
    fc.assert(
      fc.property(aPurpose, aChoice, fc.dictionary(fc.constantFrom("extra", "note", "at"), fc.jsonValue()), (purpose, choice, extra) => {
        fc.pre(levelsOf(choice, new Set(PROVIDERS)) !== undefined);
        const { db, settings, rows } = fresh();
        const carried = { ...extra, ...choice };
        const keys = ["modelId", "provider", "thinkingLevel"];

        expect(Object.keys(settings.set(purpose, carried)).sort()).toEqual(keys);
        expect(keysOf(rows()[0]?.value ?? "{}")).toEqual(keys);
        db.prepare("UPDATE ky_purposes SET value = ? WHERE purpose = ?").run(JSON.stringify(carried), purpose);
        expect(Object.keys(settings.get(purpose) ?? {}).sort()).toEqual(keys);
        db.close();
      }),
      RUNS
    );
  });
});
