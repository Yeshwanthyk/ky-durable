import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AVATAR_TABLES, EXAMPLES } from "../../src/avatars/contract";
import { Avatars, avatarTools, Setup } from "../../src/avatars/wiring";
import { budget, type Json } from "../parity/kit";
import { storageOf } from "../parity/skills/storage";

fc.configureGlobal({ baseSize: "large" });

const START = Date.UTC(2026, 0, 1);

const OWNERS = ["ky", "pip"];

const A_SPEC_IS =
  'A spec is { name?, body: { w, h, corner, color: "#rrggbb" }, eyes: { count: 1 | 2, size }, top: { kind: "none" | "antenna" | "leaf" | "ears" | "sprout" | "tuft", color? }, cheeks: boolean, feet: boolean }.';

const aNumber = fc.oneof(
  { arbitrary: fc.integer({ min: -40, max: 200 }), weight: 12 },
  { arbitrary: fc.double({ min: -1000, max: 1000, noNaN: true }), weight: 3 },
  { arbitrary: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY), weight: 1 }
);

const aColor = fc.oneof({ arbitrary: fc.constantFrom("#f0393c", "#ABCDEF", "#3cc46a"), weight: 12 }, { arbitrary: fc.constantFrom("red", "#abc", "#aabbcc\n", ""), weight: 1 });

const aName = fc.oneof(
  { arbitrary: fc.constantFrom("Pip", " Tok ", "x".repeat(24)), weight: 6 },
  { arbitrary: fc.constantFrom("  ", "x".repeat(25), "👨‍👩‍👧".repeat(24), "👨‍👩‍👧".repeat(25)), weight: 1 }
);

const aMadeSpec = fc.record(
  {
    name: aName,
    body: fc.record({ w: aNumber, h: aNumber, corner: aNumber, color: aColor }),
    eyes: fc.record({ count: fc.oneof({ arbitrary: fc.constantFrom(1, 2), weight: 12 }, { arbitrary: fc.constant(3), weight: 1 }), size: aNumber }),
    top: fc.record(
      { kind: fc.oneof({ arbitrary: fc.constantFrom("none", "antenna", "leaf", "ears", "sprout", "tuft"), weight: 12 }, { arbitrary: fc.constant("hat"), weight: 1 }), color: aColor },
      { requiredKeys: ["kind"] }
    ),
    cheeks: fc.oneof({ arbitrary: fc.boolean(), weight: 12 }, { arbitrary: fc.constant("yes"), weight: 1 }),
    feet: fc.boolean(),
    extra: fc.constant(1)
  },
  { requiredKeys: ["body", "eyes", "top", "cheeks", "feet"] }
);

const aSpec: fc.Arbitrary<Json> = fc.oneof({ arbitrary: aMadeSpec, weight: 4 }, { arbitrary: fc.constantFrom(...Object.values(EXAMPLES)), weight: 1 });

type Input = { readonly action: string; readonly for?: string; readonly spec?: Json; readonly specs?: Json[]; readonly count?: number };

// SAFETY: the avatar tool's execute never reads its api.
const API = {} as ToolExecutionApi;

type Uuid = `${string}-${string}-${string}-${string}-${string}`;

type Said = { readonly text: string; readonly isError: boolean | null };

async function said(tool: Extension, input: Input): Promise<Said> {
  const [registered] = tool.tools ?? [];
  // SAFETY: a property feeds the tool what a model could send, B's parameters unchecked as the runtime leaves them.
  const result = await registered?.execute(input as never, API, BACKGROUND_CONTEXT);

  return { text: (result?.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), isError: result?.isError ?? null };
}

const jsonOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

afterEach(() => {
  vi.restoreAllMocks();
});

const Value = Schema.Struct({ value: Schema.String });

const Spec = Schema.Struct({ owner: Schema.String, spec: Schema.String });

function port(owners: readonly string[] = OWNERS) {
  let at = START;
  vi.spyOn(Date, "now").mockImplementation(() => at);
  const db = new DatabaseSync(":memory:");
  const avatars = new Avatars(storageOf(db));
  const side = { avatars, setup: new Setup(storageOf(db)), tool: avatarTools(avatars, () => owners) };
  const heard = { avatars: 0, setup: 0 };

  side.avatars.onChange(() => heard.avatars++);
  side.setup.onChange(() => heard.setup++);

  return {
    ...side,
    db,
    heard,
    say: async (input: Input) => {
      const { text } = await said(side.tool, input);

      return text;
    },
    stored: (key: string) => db.prepare(`SELECT value FROM ${AVATAR_TABLES.setup} WHERE key = ?`).all(key).map((row) => Schema.decodeUnknownSync(Value)(row).value)[0],
    saved: () => db.prepare(`SELECT owner, spec FROM ${AVATAR_TABLES.avatars} ORDER BY owner`).all().map((row) => Schema.decodeUnknownSync(Spec)(row)),
    advance: (ms: number) => void (at += ms),
    now: () => at,
    [Symbol.dispose]: () => db.close()
  };
}

const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));

const segments = new Intl.Segmenter();

const ASpec = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.makeFilter((name: string) => [...segments.segment(name)].length <= 24))),
  body: Schema.Struct({ w: Schema.Finite, h: Schema.Finite, corner: Schema.Finite, color: Color }),
  eyes: Schema.Struct({ count: Schema.Literals([1, 2]), size: Schema.Finite }),
  top: Schema.Struct({ kind: Schema.Literals(["none", "antenna", "leaf", "ears", "sprout", "tuft"]), color: Schema.optionalKey(Color) }),
  cheeks: Schema.Boolean,
  feet: Schema.Boolean
});

const isSpec = Schema.is(ASpec);

const fencedOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Json)));

const fenced = (text: string) => fencedOf(text.split("```bloubs\n")[1]?.split("\n```")[0] ?? "[]");

describe("set", () => {
  it("refuses a spec that isn't one in B's words and saves nothing; saves one that is", async () => {
    await fc.assert(
      fc.asyncProperty(aSpec, async (spec) => {
        using ky = port();
        const reply = await ky.say({ action: "set", for: "pip", spec });

        if (isSpec(spec)) expect(reply).toMatch(/^Saved as @pip's avatar\./);
        else expect([reply, ky.saved()]).toEqual([A_SPEC_IS, []]);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("refuses an owner no one is before it looks at the spec, and asks for a spec it wasn't given", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("ky", "pip", "nobody", undefined), fc.option(aSpec, { nil: undefined }), async (owner, spec) => {
        using ky = port();
        const reply = await ky.say({ action: "set", for: owner, spec });

        if (owner === "nobody") expect(reply).toBe('No one is called nobody: use "ky" or a specialist\'s id.');
        else if (spec === undefined) expect(reply).toBe("set needs a spec.");
        else expect(reply === A_SPEC_IS).toBe(!isSpec(spec));
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("stores the spec it shows under the owner it names, and nothing for anyone else", async () => {
    await fc.assert(
      fc.asyncProperty(aSpec.filter(isSpec), fc.constantFrom("ky", "pip"), async (spec, owner) => {
        using ky = port();
        const reply = await ky.say({ action: "set", for: owner, spec });
        const [shown] = fenced(reply);

        expect(ky.saved().map(({ owner: who, spec: stored }) => [who, jsonOf(stored)])).toEqual([[owner, shown]]);
        expect(ky.avatars.all()).toEqual({ [owner]: shown });
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

describe("preview", () => {
  it("names the first option that isn't a spec, and asks for specs when it has none", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(aSpec, { maxLength: 6 }), async (specs) => {
        using ky = port();
        const reply = await ky.say({ action: "preview", specs });
        const bad = specs.findIndex((spec) => !isSpec(spec));

        if (bad >= 0) expect(reply).toBe(`Option ${bad + 1}: ${A_SPEC_IS}`);
        else if (specs.length === 0) expect(reply).toBe("preview needs specs.");
        else expect(fenced(reply)).toHaveLength(specs.length);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

describe("setRepo", () => {
  const aRepo = fc.oneof(fc.constantFrom("a/b", " o-w.n/r_e.p ", "owner", "a/b/c", "own er/name", "x/y z", "/b", "a/"), fc.string({ maxLength: 12 }));

  it("refuses what isn't owner/name, then a page it can't place, in B's words, and stores nothing", async () => {
    await fc.assert(
      fc.asyncProperty(aRepo, fc.constantFrom(null, "https://ky.test/x"), async (repo, page) => {
        using ky = port();
        const trimmed = repo.trim();
        const isRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed);
        const saved = ky.setup.setRepo(repo, page);

        if (trimmed !== "" && !isRepo) expect(saved).toEqual({ refused: `"${trimmed}" is not a GitHub repo; write it as owner/name.` });
        else if (trimmed !== "" && page === null) expect(saved).toEqual({ refused: "This page's address is unknown; reload it and try again." });
        else expect(saved).toEqual({});

        if ("refused" in saved) expect([ky.stored("repo"), ky.stored("url")]).toEqual([undefined, undefined]);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("stores the repo trimmed and the page's origin as the address; opened keeps the origin it was opened on", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("a/b", " me/ky "), fc.constantFrom("https://ky.test/chat?x=1", "http://localhost:8787/a"), async (repo, page) => {
        using ky = port();
        ky.setup.setRepo(repo, page);
        ky.setup.opened(page);
        const origin = new URL(page).origin;

        expect([ky.stored("repo"), ky.stored("url"), ky.stored("origin")]).toEqual([repo.trim(), origin, origin]);
        expect(ky.setup.selfEdit()).toEqual({ repo: repo.trim(), url: origin });
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

describe("the seeded time", () => {
  it("is the clock's when the first start asks, which is true once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 10 ** 9 }), fc.integer({ min: 1, max: 10 ** 9 }), async (wait, later) => {
        using ky = port();
        ky.advance(wait);
        const at = ky.now();

        expect(ky.setup.firstStart()).toBe(true);
        ky.advance(later);
        expect(ky.setup.firstStart()).toBe(false);
        expect(ky.stored("seeded")).toBe(String(at));
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("is the clock's when a restore moves an unseeded ky, and stays when it was seeded", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.integer({ min: 1, max: 10 ** 9 }), async (seeded, later) => {
        using ky = port();

        if (seeded) ky.setup.firstStart();
        const before = ky.now();
        ky.advance(later);
        ky.setup.moved("https://new.test");

        expect(ky.stored("seeded")).toBe(String(seeded ? before : ky.now()));
        expect(ky.setup.firstStart()).toBe(false);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

const FOUR = ["al", "ky", "pip", "zed"];

const Whole = (min: number, max: number) => Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }));

const Lower = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/));

const Fitted = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\S(.*\S)?$/s))),
  body: Schema.Struct({ w: Whole(80, 124), h: Whole(80, 124), corner: Whole(0, 62), color: Lower }).check(Schema.makeFilter(({ w, h, corner }) => corner <= Math.round(Math.min(w, h) / 2))),
  eyes: Schema.Struct({ count: Schema.Literals([1, 2]), size: Whole(8, 32) }),
  top: Schema.Union([Schema.Struct({ kind: Schema.Literal("none"), color: Schema.optionalKey(Schema.Never) }), Schema.Struct({ kind: Schema.Literals(["antenna", "leaf", "ears", "sprout", "tuft"]), color: Schema.optionalKey(Lower) })]),
  cheeks: Schema.Boolean,
  feet: Schema.Boolean
});

const isFitted = Schema.is(Fitted);

const shownRange = (spec: Schema.Json) => isSpec(spec) && isFitted(spec);

describe("roll", () => {
  it("offers one to six fitted bloubs, three when not asked, the same ones for the same seed", async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(fc.double({ min: -20, max: 20, noNaN: true }), { nil: undefined }), fc.uuid(), async (count, seed) => {
        const rolled = async () => {
          using ky = port();

          // SAFETY: fc.uuid makes the five-part ids randomUUID returns.
          vi.spyOn(crypto, "randomUUID").mockImplementation(() => seed as Uuid);

          return ky.say({ action: "roll", count });
        };

        const reply = await rolled();
        const many = count === undefined ? 3 : Math.round(count) < 1 ? 1 : Math.round(count) > 6 ? 6 : Math.round(count);
        const specs = fenced(reply);

        expect(reply).toMatch(new RegExp(`^Rolled ${many}\\.`));
        expect(specs).toHaveLength(many);
        expect(specs.every((spec) => isSpec(spec) && shownRange(spec))).toBe(true);
        expect(await rolled()).toBe(reply);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("shows the examples as they are, and any spec it takes pulled into range", async () => {
    await fc.assert(
      fc.asyncProperty(aSpec.filter(isSpec), async (spec) => {
        using ky = port();
        const examples = Object.values(EXAMPLES);

        expect(fenced(await ky.say({ action: "preview", specs: [...examples] }))).toEqual(examples);
        expect(fenced(await ky.say({ action: "preview", specs: [spec] })).every(shownRange)).toBe(true);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

describe("clear and list", () => {
  it("clear says whether the owner had an avatar, removes only theirs, and tells only when it did", async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray(FOUR), fc.constantFrom(...FOUR), async (owners, cleared) => {
        using ky = port(FOUR);

        for (const owner of owners) await ky.say({ action: "set", for: owner, spec: EXAMPLES.pip });

        const before = ky.heard.avatars;
        const had = owners.includes(cleared);

        expect(await ky.say({ action: "clear", for: cleared })).toBe(had ? `${cleared} looks as before again.` : `${cleared} has no avatar saved.`);
        expect(ky.saved().map(({ owner }) => owner)).toEqual(owners.filter((owner) => owner !== cleared).sort());
        expect(ky.heard.avatars - before).toBe(had ? 1 : 0);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("list names every saved owner in order with their bloubs, or says there are none", async () => {
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray(FOUR), async (owners) => {
        using ky = port(FOUR);
        const examples = Object.values(EXAMPLES);

        for (const [index, owner] of owners.entries()) await ky.say({ action: "set", for: owner, spec: examples[index] });

        const sorted = [...owners].sort();
        const reply = await ky.say({ action: "list" });

        if (sorted.length === 0) expect(reply).toBe("No avatars saved.");
        else {
          expect(reply).toMatch(new RegExp(`^Saved: ${sorted.join(", ")}\\.`));
          expect(fenced(reply)).toEqual(sorted.map((owner) => examples[owners.indexOf(owner)]));
        }

        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("reads past a row that isn't a spec, and keeps a spec's extra keys", async () => {
    const aRow = fc.oneof(aSpec.map((spec) => JSON.stringify(spec)), fc.constantFrom("not json", "null", "[]", '{"body":1}'), fc.string({ maxLength: 40 }));

    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.constantFrom(...FOUR), aRow), async (rows) => {
        using ky = port(FOUR);

        for (const [owner, spec] of Object.entries(rows)) ky.db.prepare(`INSERT INTO ${AVATAR_TABLES.avatars} (owner, spec) VALUES (?, ?)`).run(owner, spec);

        const parsed = Object.entries(rows).flatMap(([owner, spec]): [string, string][] => {
          const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(spec);

          return json._tag === "Some" && isSpec(json.value) ? [[owner, JSON.stringify(json.value)]] : [];
        });

        expect(JSON.stringify(ky.avatars.all())).toBe(`{${parsed.sort(([a], [b]) => (a < b ? -1 : 1)).map(([owner, spec]) => `${JSON.stringify(owner)}:${spec}`).join(",")}}`);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});

describe("where ky lives", () => {
  it("a restore moves the address and the origin it had, and leaves the ones it didn't", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), fc.constantFrom("https://new.test", "http://localhost:9000"), async (repo, opened, origin) => {
        using ky = port();

        if (repo) ky.setup.setRepo("me/ky", "https://ky.test/chat");

        if (opened) ky.setup.opened("https://ky.test/settings");
        ky.setup.moved(origin);

        expect([ky.stored("url"), ky.stored("origin")]).toEqual([repo ? origin : undefined, opened ? origin : undefined]);
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("a blank repo forgets the repo, keeps the address, and tells", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("", " ", "\t\n"), fc.constantFrom(null, "https://other.test/x"), async (blank, page) => {
        using ky = port();
        ky.setup.setRepo("me/ky", "https://ky.test/chat");
        const before = ky.heard.setup;

        expect(ky.setup.setRepo(blank, page)).toEqual({});
        expect([ky.stored("repo"), ky.stored("url"), ky.heard.setup - before]).toEqual([undefined, "https://ky.test", 1]);
        expect(ky.setup.selfEdit()).toBeUndefined();
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });

  it("a stored value that isn't text reads as absent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("repo", "url", "origin", "seeded"), async (key) => {
        using ky = port();
        ky.db.prepare(`INSERT INTO ${AVATAR_TABLES.setup} (key, value) VALUES (?, X'00')`).run(key);
        const at = ky.now();

        expect([ky.setup.view(), ky.setup.selfEdit(), ky.setup.origin()]).toEqual([{ repo: null, url: null }, undefined, null]);
        expect(ky.setup.firstStart()).toBe(true);
        expect(ky.stored("seeded")).toBe(String(at));
        vi.restoreAllMocks();
      }),
      { numRuns: budget().numRuns * 4, seed: budget().seed }
    );
  });
});
