import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preamble as legacyPreamble } from "../../src/avatars/legacy/prompt";
import { AVATAR_TABLES, EXAMPLES } from "../../src/avatars/contract";
import { Avatars, avatarTools, preamble, Setup } from "../../src/avatars/wiring";
import { assertParity, type Clock, type Instance, type Json, type Parity } from "../parity/kit";
import { legacyOf } from "../parity/avatars/legacy";
import { storageOf, StoredRow } from "../parity/skills/storage";

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

const aPage = fc.constantFrom("https://ky.test/chat?x=1", "http://localhost:8787/", "HTTPS://KY.TEST:443/", "not a url", "");

type Input = { readonly action: string; readonly for?: string; readonly spec?: Json; readonly specs?: Json[]; readonly count?: number };

type Action =
  | { readonly tool: Input }
  | { readonly damage: string; readonly spec: string }
  | { readonly blob: true }
  | { readonly setRepo: string; readonly page: string | null }
  | { readonly opened: string }
  | { readonly moved: string }
  | { readonly setup: "view" | "selfEdit" | "firstStart" | "origin" }
  | { readonly read: true };

const actions: fc.Arbitrary<Action> = fc.oneof(
  {
    arbitrary: fc
      .record(
        {
          action: fc.constantFrom("preview", "roll", "set", "clear", "list"),
          for: fc.constantFrom("ky", "pip", "nobody"),
          spec: aSpec,
          specs: fc.array(aSpec, { maxLength: 7 }),
          count: fc.constantFrom(0, 1, 2.5, 3, 6, 9, -1, Number.NaN)
        },
        { requiredKeys: ["action"] }
      )
      .map((tool) => ({ tool })),
    weight: 10
  },
  {
    arbitrary: fc.record({
      damage: fc.constantFrom("ky", "pip", "zed"),
      spec: fc.constantFrom(
        "not json",
        "null",
        "5",
        '{"body":1}',
        JSON.stringify(EXAMPLES.tok),
        JSON.stringify({ ...EXAMPLES.pip, extra: { deep: true } }),
        JSON.stringify({ ...EXAMPLES.pip, body: { ...EXAMPLES.pip.body, w: "1" } }),
        '{"body":{"w":1e999,"h":100,"corner":10,"color":"#aabbcc"},"eyes":{"count":1,"size":20},"top":{"kind":"none"},"cheeks":true,"feet":true}'
      )
    }),
    weight: 2
  },
  { arbitrary: fc.constant({ blob: true as const }), weight: 1 },
  {
    arbitrary: fc.record({
      setRepo: fc.constantFrom("", "  ", "a/b", " owner/name ", "owner", "a/b/c", "o-w.n/r_e.p", "own er/name"),
      page: fc.oneof(fc.constant(null), aPage)
    }),
    weight: 4
  },
  { arbitrary: fc.record({ opened: aPage }), weight: 2 },
  { arbitrary: fc.record({ moved: fc.constantFrom("https://new.test", "http://localhost:9000") }), weight: 2 },
  { arbitrary: fc.record({ setup: fc.constantFrom<"view" | "selfEdit" | "firstStart" | "origin">("view", "selfEdit", "firstStart", "origin") }), weight: 3 },
  { arbitrary: fc.constant({ read: true as const }), weight: 1 }
);

type Side = {
  readonly avatars: { all(): object; onChange(listener: () => void): unknown };
  readonly setup: Pick<Setup, "onChange" | "view" | "selfEdit" | "firstStart" | "origin" | "opened" | "moved"> & { setRepo(repo: string, page: string | null): object };
  readonly tool: Extension;
};

type Make = (db: DatabaseSync, owners: () => readonly string[]) => Side;

const next: Make = (db, owners) => {
  const avatars = new Avatars(storageOf(db));

  return { avatars, setup: new Setup(storageOf(db)), tool: avatarTools(avatars, owners) };
};

const API = {} as ToolExecutionApi;

let uuid = () => "";

async function said(tool: Extension, input: Input): Promise<Json> {
  const [registered] = tool.tools ?? [];
  const result = await registered?.execute(input as never, API, BACKGROUND_CONTEXT);

  return { text: (result?.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), isError: result?.isError ?? null };
}

function caught(work: () => Json | undefined | void): Json {
  try {
    return work() ?? null;
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

const rowsDecoded = Schema.decodeUnknownSync(Schema.Array(StoredRow));

const shownValue = (value: unknown) => (value instanceof Uint8Array ? `x'${Buffer.from(value).toString("hex")}'` : value);

const rowsOf = (db: DatabaseSync, table: string): Json[] => [
  ...rowsDecoded(
    db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, shownValue(value)])))
  )
];

function instance(db: DatabaseSync, make: Make): Instance<Action> {
  const side = make(db, () => OWNERS);
  const seen = { avatarChanges: 0, setupChanges: 0 };
  let rolled = 0;
  const ownUuid = () => `00000000-0000-4000-8000-${String(rolled++).padStart(12, "0")}`;

  side.avatars.onChange(() => seen.avatarChanges++);
  side.setup.onChange(() => seen.setupChanges++);

  const apply = async (action: Action): Promise<Json> => {
    if ("tool" in action) {
      uuid = ownUuid;

      return said(side.tool, action.tool);
    }

    if ("damage" in action) return caught(() => void db.prepare(`INSERT OR REPLACE INTO ${AVATAR_TABLES.avatars} (owner, spec) VALUES (?, ?)`).run(action.damage, action.spec));

    if ("blob" in action) return caught(() => void db.prepare(`INSERT OR REPLACE INTO ${AVATAR_TABLES.avatars} (owner, spec) VALUES (X'7A', ?)`).run(JSON.stringify(EXAMPLES.fern)));

    if ("setRepo" in action) return caught(() => JSON.parse(JSON.stringify(side.setup.setRepo(action.setRepo, action.page))));

    if ("opened" in action) return caught(() => side.setup.opened(action.opened));

    if ("moved" in action) return caught(() => side.setup.moved(action.moved));

    if ("setup" in action) return caught(() => side.setup[action.setup]());

    return caught(() => JSON.parse(JSON.stringify(side.avatars.all())));
  };

  return {
    apply,
    tables: async () => ({
      schema: db
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'ky_%' ORDER BY name")
        .all()
        .map(({ type, name, sql }) => ({ type: String(type), name: String(name), sql: String(sql).replace(/\s+/g, " ").replace("( ", "(") })),
      avatars: rowsOf(db, AVATAR_TABLES.avatars),
      setup: rowsOf(db, AVATAR_TABLES.setup)
    }),
    effects: async () => seen,
    dispose: async () => db.close()
  };
}

function useClock(clock: Clock): void {
  vi.spyOn(Date, "now").mockImplementation(() => clock.now());
}

beforeEach(() => {
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => uuid() as `${string}-${string}-${string}-${string}-${string}`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const avatarsParity: Parity<Action> = {
  domain: "avatars",
  actions,
  start: START,
  advances: fc.integer({ min: 0, max: 86_400_000 }),
  legacy: async (clock) => {
    useClock(clock);

    return instance(new DatabaseSync(":memory:"), legacyOf);
  },
  next: async () => instance(new DatabaseSync(":memory:"), next)
};

describe("avatars parity", () => {
  it("answers, stores and tells what B does, step for step", async () => {
    await assertParity(avatarsParity);
  });

  it("writes the main prompt B writes, for every deploy", () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            executor: fc.boolean(),
            cloud: fc.constantFrom("default", "box"),
            selfEdit: fc.record({ repo: fc.constantFrom("me/ky"), url: fc.constantFrom("https://ky.test") }),
            selfEditOn: fc.constantFrom("default", "repo-box")
          },
          { requiredKeys: ["executor"] }
        ),
        (config) => {
          expect(preamble(config)).toBe(legacyPreamble(config));
        }
      )
    );
  });
});

const Value = Schema.Struct({ value: Schema.String });

const Spec = Schema.Struct({ owner: Schema.String, spec: Schema.String });

function port(owners: readonly string[] = OWNERS) {
  let at = START;
  vi.spyOn(Date, "now").mockImplementation(() => at);
  const db = new DatabaseSync(":memory:");
  const side = next(db, () => owners);

  return {
    ...side,
    db,
    say: async (input: Input) => {
      const reply = await said(side.tool, input);

      const text = typeof reply === "object" && reply !== null && "text" in reply ? reply.text : null;

      return typeof text === "string" ? text : null;
    },
    stored: (key: string) => db.prepare(`SELECT value FROM ${AVATAR_TABLES.setup} WHERE key = ?`).all(key).map((row) => Schema.decodeUnknownSync(Value)(row).value)[0],
    saved: () => db.prepare(`SELECT owner, spec FROM ${AVATAR_TABLES.avatars} ORDER BY owner`).all().map((row) => Schema.decodeUnknownSync(Spec)(row)),
    advance: (ms: number) => void (at += ms),
    now: () => at,
    [Symbol.dispose]: () => db.close()
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const segments = new Intl.Segmenter();

const isObject = (value: Json | undefined): value is { readonly [key: string]: Json | undefined } => typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: Json | undefined) => typeof value === "number" && Number.isFinite(value);

function isSpec(spec: Json): boolean {
  if (!isObject(spec) || !isObject(spec.body) || !isObject(spec.eyes) || !isObject(spec.top)) return false;
  const { name, body, eyes, top } = spec;

  return (
    (name === undefined || (typeof name === "string" && [...segments.segment(name)].length <= 24)) &&
    finite(body.w) &&
    finite(body.h) &&
    finite(body.corner) &&
    typeof body.color === "string" &&
    HEX.test(body.color) &&
    !body.color.endsWith("\n") &&
    (eyes.count === 1 || eyes.count === 2) &&
    finite(eyes.size) &&
    typeof top.kind === "string" &&
    ["none", "antenna", "leaf", "ears", "sprout", "tuft"].includes(top.kind) &&
    (top.color === undefined || (typeof top.color === "string" && HEX.test(top.color) && !top.color.endsWith("\n"))) &&
    typeof spec.cheeks === "boolean" &&
    typeof spec.feet === "boolean"
  );
}

const fenced = (text: string | null) => JSON.parse(text?.split("```bloubs\n")[1]?.split("\n```")[0] ?? "null");

describe("set", () => {
  it("refuses a spec that isn't one in B's words and saves nothing; saves one that is", async () => {
    await fc.assert(
      fc.asyncProperty(aSpec, async (spec) => {
        using ky = port();
        const reply = await ky.say({ action: "set", for: "pip", spec });

        if (isSpec(spec)) expect(reply).toMatch(/^Saved as @pip's avatar\./);
        else expect([reply, ky.saved()]).toEqual([A_SPEC_IS, []]);
        vi.restoreAllMocks();
      })
    );
  });

  it("refuses an owner no one is before it looks at the spec, and asks for a spec it wasn't given", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("ky", "pip", "nobody", undefined), fc.option(aSpec, { nil: undefined }), async (owner, spec) => {
        using ky = port();
        const reply = await ky.say({ action: "set", ...(owner === undefined ? {} : { for: owner }), ...(spec === undefined ? {} : { spec }) });

        if (owner === "nobody") expect(reply).toBe('No one is called nobody: use "ky" or a specialist\'s id.');
        else if (spec === undefined) expect(reply).toBe("set needs a spec.");
        else expect(reply === A_SPEC_IS).toBe(!isSpec(spec));
        vi.restoreAllMocks();
      })
    );
  });

  it("stores the spec it shows under the owner it names, and nothing for anyone else", async () => {
    await fc.assert(
      fc.asyncProperty(aSpec.filter(isSpec), fc.constantFrom("ky", "pip"), async (spec, owner) => {
        using ky = port();
        const reply = await ky.say({ action: "set", for: owner, spec });
        const [shown] = fenced(reply);

        expect(ky.saved().map(({ owner: who, spec: stored }) => [who, JSON.parse(stored)])).toEqual([[owner, shown]]);
        expect(ky.avatars.all()).toEqual({ [owner]: shown });
        vi.restoreAllMocks();
      })
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
      })
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
      })
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
      })
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
      })
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
      })
    );
  });
});
