import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type ModelChoice, nearestLevel } from "../../src/settings/contract";
import { Settings } from "../../src/settings/wiring";
import { nearestLevel as legacyNearest } from "../../src/settings/legacy/settings";
import { assertParity, type Instance, type Json, type Parity } from "../parity/kit";
import { legacyOf } from "../parity/settings/legacy";
import { CATALOG, levelsOf, type Nearest, PURPOSES, type PurposeName, validOf } from "../parity/settings/reads";
import { storageOf } from "../parity/skills/storage";

const ORDER: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const PROVIDERS = ["workers-ai", "vibeproxy", "gone"];

const MODELS = [...[...CATALOG.values()].flatMap((models) => [...models.keys()]), "retired"];

type Side = Pick<Settings, "get" | "set" | "onChange">;

type Action =
  { readonly set: PurposeName; readonly choice: ModelChoice } | { readonly get: PurposeName } | { readonly connect: readonly string[] } | { readonly store: PurposeName; readonly raw: string };

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

const actions: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: fc.record({ set: aPurpose, choice: aChoice }), weight: 4 },
  { arbitrary: fc.record({ get: aPurpose }), weight: 3 },
  { arbitrary: fc.record({ connect: fc.subarray(PROVIDERS) }), weight: 1 },
  { arbitrary: fc.record({ store: aPurpose, raw: aRaw }), weight: 2 }
);

const hasExtra = (raw: string) => raw.includes('"extra"');

const shown = (choice: ModelChoice | undefined): Json =>
  choice
    ? {
        provider: choice.provider,
        modelId: choice.modelId,
        thinkingLevel: choice.thinkingLevel
      }
    : null;

function world(make: (db: DatabaseSync, valid: (choice: ModelChoice) => ModelChoice | undefined) => Side, nearest: Nearest) {
  const db = new DatabaseSync(":memory:");
  const state = { connected: new Set<string>(PROVIDERS) };
  const heard: Json[] = [];

  const settings = make(db, (choice) => validOf(nearest, state.connected)(choice));

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

const legacySide = (db: DatabaseSync, valid: (choice: ModelChoice) => ModelChoice | undefined): Side => legacyOf(db, valid);

const nextSide = (db: DatabaseSync, valid: (choice: ModelChoice) => ModelChoice | undefined): Side => new Settings(storageOf(db), valid);

const fresh = () => world(nextSide, nearestLevel);

async function instance(make: typeof legacySide, nearest: Nearest): Promise<Instance<Action>> {
  const { db, state, heard, settings, rows } = world(make, nearest);

  return {
    apply: async (action) => {
      if ("connect" in action) {
        state.connected = new Set(action.connect);

        return null;
      }

      if ("store" in action) {
        db.prepare("INSERT INTO ky_purposes (purpose, value) VALUES (?, ?) ON CONFLICT(purpose) DO UPDATE SET value = excluded.value").run(action.store, action.raw);

        return null;
      }

      if ("get" in action) return shown(settings.get(action.get));

      try {
        return shown(settings.set(action.set, action.choice));
      } catch (error) {
        return {
          refused: error instanceof Error ? error.message : String(error)
        };
      }
    },
    tables: async () => ({
      schema: db
        .prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'ky_%' ORDER BY name")
        .all()
        .map((row) => String(row.sql)),
      ky_purposes: rows()
    }),
    effects: async () => heard,
    dispose: async () => db.close()
  };
}

const settingsParity: Parity<Action> = {
  domain: "settings",
  actions,
  legacy: async () => instance(legacySide, legacyNearest),
  next: async () => instance(nextSide, nearestLevel),
  divergences: [
    {
      name: "drops-extra-keys",
      covers: (action) => "store" in action && hasExtra(action.raw),
      heldBy: "test/invariants/settings.test.ts > keeps only a choice's provider, model and level, whatever else it carries"
    }
  ]
};

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

describe("settings parity", () => {
  it("answers, stores and tells its listeners what B does, step for step", async () => {
    await assertParity(settingsParity);
  });
});

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
      })
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
      })
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
      })
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
      })
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
      })
    );
  });
});
