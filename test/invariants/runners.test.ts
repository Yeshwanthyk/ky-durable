import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import fc from "fast-check";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Sql } from "../../src/core/sql";
import { CODE_TTL_MS, IDLE_MAX, type RouteRefused, RUNNER_TABLES, SANDBOX_CAP, type Sandbox, saveKey } from "../../src/runners/contract";
import { ownerRoute, tokenRoute } from "../../src/runners/routes";
import { Registry, type SandboxRegistry } from "../../src/runners/sandboxes";
import { pairAs } from "../../src/runners/wiring";
import { assertParity, budget, type Json, type Parity } from "../parity/kit";
import { legacy } from "../parity/runners/legacy";
import { type Action, actions, FACTS, fakeUuids, instanceOf, MACHINE_TOKEN, next, storageOf, T, TASK_TOKEN, uuidsFrom, World } from "../parity/runners/world";

const DATE = T - 3_600_000;

const words = {
  notAName: "A name is lowercase letters, digits and dashes, up to 32.",
  taken: (name: string) => `${name} is taken; pick another name.`,
  atCap: `ky runs at most ${SANDBOX_CAP} sandboxes; delete one first.`,
  notARepo: (repo: string) => `A repo is owner/name, not ${JSON.stringify(repo)}.`,
  owned: (repo: string, owner: string) => `${repo} is already ${owner}'s; a repo belongs to one sandbox.`,
  noKeptDisk: (id: string) => `No kept disk ${id}.`,
  noSandbox: (id: string) => `No sandbox ${id}.`,
  badIdle: `Idle minutes are a whole number from 1 to ${IDLE_MAX}.`
};

const runs = () => ({ numRuns: Math.max(10, Math.round(budget().numRuns / 5)), seed: budget().seed });

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  fakeUuids();
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Harness = {
  readonly registry: SandboxRegistry;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly refusal: <A, E extends { readonly refusal: string; readonly _tag: string }>(effect: Effect.Effect<A, E>) => Promise<E>;
  readonly at: (ms: number) => Promise<void>;
  readonly db: DatabaseSync;
  readonly rows: () => Json[];
};

async function registryWith(test: (harness: Harness) => Promise<void>): Promise<void> {
  vi.setSystemTime(DATE);
  uuidsFrom({ uuids: 0 });
  const db = new DatabaseSync(":memory:");
  const runtime = ManagedRuntime.make(Registry.layer.pipe(Layer.provideMerge(Layer.mergeAll(Sql.layer(storageOf(db).storage()), TestClock.layer()))));

  try {
    await runtime.runPromise(TestClock.setTime(T));
    const registry = await runtime.runPromise(Registry.use(Effect.succeed));

    await test({
      registry,
      run: (effect) => runtime.runPromise(effect),
      refusal: (effect) => runtime.runPromise(Effect.flip(effect)),
      at: (ms) => runtime.runPromise(TestClock.setTime(ms)),
      db,
      rows: () =>
        // SAFETY: the runners' tables hold text, integers and nulls, which JSON shows as they are.
        db
          .prepare(`SELECT * FROM ${RUNNER_TABLES.sandboxes} ORDER BY id`)
          .all()
          .map((row) => ({ ...row }) as Json)
    });
  } finally {
    await runtime.dispose();
    db.close();
  }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

const anyName = fc.oneof(fc.constantFrom("web", " web ", "a", "a".repeat(32), "a".repeat(33), "-web", "Web", "w_b", "w.b", "", "9lives"), fc.string({ maxLength: 40 }));

const anyRepo = fc.oneof(fc.constantFrom("acme/api", " Acme/API ", "acme", "a/b/c", "a_b/c.d", "/x", "x/", "acme/ api"), fc.string({ maxLength: 12 }));

const sandbox = (id: string, fields: Partial<Sandbox> = {}): Sandbox => ({ id, name: id, repos: [], idleMinutes: null, isDefault: false, createdAt: T - 1, deletedAt: null, ...fields });

describe("making a sandbox", () => {
  it("takes a name only when, trimmed, it is a machine's name, else refuses in B's words and writes nothing", () =>
    fc.assert(
      fc.asyncProperty(anyName, (name) =>
        registryWith(async ({ registry, run, refusal, rows }) => {
          if (NAME.test(name.trim())) {
            expect((await run(registry.create({ name }, () => false))).name).toBe(name.trim());
          } else {
            const refused = await refusal(registry.create({ name }, () => false));

            expect([refused._tag, refused.refusal]).toEqual(["NotAName", words.notAName]);
            expect(rows()).toEqual([]);
          }
        })
      ),
      runs()
    ));

  it("refuses a name a computer has, or a live sandbox, and takes a kept disk's", () =>
    registryWith(async ({ registry, run, refusal }) => {
      const taken = await refusal(registry.create({ name: "box" }, (name) => name === "box"));

      expect([taken._tag, taken.refusal]).toEqual(["NameTaken", words.taken("box")]);
      const web = await run(registry.create({ name: "web" }, () => false));

      expect((await refusal(registry.create({ name: " web " }, () => false))).refusal).toBe(words.taken("web"));
      await run(registry.delete(web.id));
      expect((await run(registry.create({ name: "web" }, () => false))).id).not.toBe(web.id);
    }));

  it(`refuses the ${SANDBOX_CAP + 1}th live sandbox, and takes one again once one is deleted`, () =>
    registryWith(async ({ registry, run, refusal }) => {
      const made: Sandbox[] = [];

      for (let n = 0; n < SANDBOX_CAP; n += 1) made.push(await run(registry.create({ name: `s${n}` }, () => false)));
      const refused = await refusal(registry.create({ name: "over" }, () => false));

      expect([refused._tag, refused.refusal]).toEqual(["AtCap", words.atCap]);
      expect(await run(registry.live)).toHaveLength(SANDBOX_CAP);
      await run(registry.delete(made[0]!.id));
      expect((await run(registry.create({ name: "over" }, () => false))).name).toBe("over");
    }));

  it("keeps repos trimmed, lowercase and once each, and refuses the first that isn't owner/name", () =>
    fc.assert(
      fc.asyncProperty(fc.array(anyRepo, { maxLength: 4 }), (repos) =>
        registryWith(async ({ registry, run, refusal, rows }) => {
          const clean = [...new Set(repos.map((repo) => repo.trim().toLowerCase()))];
          const bad = clean.find((repo) => !REPO.test(repo));

          if (bad === undefined) {
            const made = await run(registry.create({ name: "web", repos }, () => false));

            expect(made.repos).toEqual(clean);
            expect(rows()).toEqual([expect.objectContaining({ id: made.id, repos: JSON.stringify(clean) })]);
          } else {
            const refused = await refusal(registry.create({ name: "web", repos }, () => false));

            expect([refused._tag, refused.refusal]).toEqual(["NotARepo", words.notARepo(bad)]);
            expect(rows()).toEqual([]);
          }
        })
      ),
      runs()
    ));

  it("refuses a repo another live sandbox owns, in either's spelling, and frees it once that one is deleted", () =>
    registryWith(async ({ registry, run, refusal }) => {
      const api = await run(registry.create({ name: "api", repos: ["acme/api"] }, () => false));
      const refused = await refusal(registry.create({ name: "web", repos: [" ACME/api"] }, () => false));

      expect([refused._tag, refused.refusal]).toEqual(["RepoOwned", words.owned("acme/api", "api")]);
      await run(registry.delete(api.id));
      expect((await run(registry.create({ name: "web", repos: ["acme/api"] }, () => false))).repos).toEqual(["acme/api"]);
    }));

  it("makes the first live sandbox the default and no other", () =>
    registryWith(async ({ registry, run }) => {
      const first = await run(registry.create({ name: "one" }, () => false));
      const second = await run(registry.create({ name: "two" }, () => false));

      expect([first.isDefault, second.isDefault]).toEqual([true, false]);
      await run(registry.delete(first.id));
      await run(registry.delete(second.id));
      expect((await run(registry.create({ name: "three" }, () => false))).isDefault).toBe(true);
    }));

  it("stamps a fresh sandbox with the Clock's time, an sb- id, and no idle minutes", () =>
    registryWith(async ({ registry, run, at }) => {
      await at(T + 42);
      const made = await run(registry.create({ name: "web" }, () => false));

      expect(made).toEqual({ id: "sb-00000001", name: "web", repos: [], idleMinutes: null, isDefault: true, createdAt: T + 42, deletedAt: null });
    }));

  it("starts one from a kept disk under its id, with the new name and repos, live again at the Clock's time", () =>
    registryWith(async ({ registry, run, refusal, at }) => {
      const old = await run(registry.create({ name: "old", repos: ["acme/old"] }, () => false));
      await run(registry.change(old.id, { idleMinutes: 30 }));
      await run(registry.delete(old.id));
      await at(T + 500);
      const back = await run(registry.create({ name: "new", repos: ["acme/new"], from: old.id }, () => false));

      expect(back).toEqual({ id: old.id, name: "new", repos: ["acme/new"], idleMinutes: 30, isDefault: true, createdAt: T + 500, deletedAt: null });
      const again = await refusal(registry.create({ name: "other", from: old.id }, () => false));

      expect([again._tag, again.refusal]).toEqual(["NoKeptDisk", words.noKeptDisk(old.id)]);
      expect((await refusal(registry.create({ name: "other", from: "sb-nope" }, () => false))).refusal).toBe(words.noKeptDisk("sb-nope"));
    }));
});

describe("changing a sandbox", () => {
  it("refuses one that isn't live", () =>
    registryWith(async ({ registry, run, refusal }) => {
      const web = await run(registry.create({ name: "web" }, () => false));
      await run(registry.delete(web.id));

      for (const id of [web.id, "sb-nope"]) {
        const refused = await refusal(registry.change(id, { idleMinutes: 5 }));

        expect([refused._tag, refused.refusal]).toEqual(["NoSandbox", words.noSandbox(id)]);
        expect((await refusal(registry.delete(id))).refusal).toBe(words.noSandbox(id));
      }
    }));

  it("takes idle minutes only as a whole number from 1 to a day, or null, else refuses in B's words", () =>
    fc.assert(
      fc.asyncProperty(fc.oneof(fc.constantFrom(0, 1, IDLE_MAX, IDLE_MAX + 1, -1, 1.5, Number.NaN), fc.integer({ min: -10, max: IDLE_MAX + 10 }), fc.double()), fc.boolean(), (minutes, cleared) =>
        registryWith(async ({ registry, run, refusal }) => {
          const web = await run(registry.create({ name: "web" }, () => false));
          const wanted = cleared ? null : minutes;

          if (wanted === null || (Number.isInteger(wanted) && wanted >= 1 && wanted <= IDLE_MAX)) {
            expect((await run(registry.change(web.id, { idleMinutes: wanted }))).idleMinutes).toBe(wanted);
          } else {
            const refused = await refusal(registry.change(web.id, { idleMinutes: wanted }));

            expect([refused._tag, refused.refusal]).toEqual(["BadIdle", words.badIdle]);
            expect((await run(registry.get(web.id)))?.idleMinutes).toBeNull();
          }
        })
      ),
      runs()
    ));

  it("writes the repos before it checks the idle minutes, as B did", () =>
    registryWith(async ({ registry, run, refusal }) => {
      const web = await run(registry.create({ name: "web" }, () => false));

      expect((await refusal(registry.change(web.id, { repos: ["acme/web"], idleMinutes: 0 }))).refusal).toBe(words.badIdle);
      expect((await run(registry.get(web.id)))?.repos).toEqual(["acme/web"]);
    }));

  it("lets a sandbox keep its own repos, and refuses another's", () =>
    registryWith(async ({ registry, run, refusal }) => {
      const api = await run(registry.create({ name: "api", repos: ["acme/api"] }, () => false));
      const web = await run(registry.create({ name: "web" }, () => false));

      expect((await run(registry.change(api.id, { repos: ["acme/api", "acme/lib"] }))).repos).toEqual(["acme/api", "acme/lib"]);
      expect((await refusal(registry.change(web.id, { repos: ["acme/lib"] }))).refusal).toBe(words.owned("acme/lib", "api"));
      expect((await refusal(registry.change(web.id, { repos: ["nope"] }))).refusal).toBe(words.notARepo("nope"));
    }));

  it("makes exactly one sandbox the default", () =>
    fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.nat(), (count, pick) =>
        registryWith(async ({ registry, run }) => {
          const made: Sandbox[] = [];

          for (let n = 0; n < count; n += 1) made.push(await run(registry.create({ name: `s${n}` }, () => false)));
          const chosen = made[pick % count]!;

          await run(registry.change(chosen.id, { isDefault: true }));
          expect((await run(registry.all)).filter((each) => each.isDefault).map((each) => each.id)).toEqual([chosen.id]);
        })
      ),
      runs()
    ));
});

describe("deleting and forgetting", () => {
  it("keeps a deleted sandbox as a kept disk, deleted at the Clock's time and no longer the default", () =>
    registryWith(async ({ registry, run, at, rows }) => {
      const web = await run(registry.create({ name: "web", repos: ["acme/web"] }, () => false));
      await at(T + 900);

      expect(await run(registry.delete(web.id))).toEqual({ ...web, isDefault: false, deletedAt: T + 900 });
      expect(rows()).toEqual([expect.objectContaining({ id: web.id, deleted_at: T + 900, is_default: 0 })]);
      expect(await run(registry.reposFor(web.id))).toBeNull();
      expect(await run(registry.owner("acme/web"))).toBeUndefined();
    }));

  it("forgets only a kept disk, and refuses a live one or none", () =>
    registryWith(async ({ registry, run, refusal, rows }) => {
      const web = await run(registry.create({ name: "web" }, () => false));
      const live = await refusal(registry.forget(web.id));

      expect([live._tag, live.refusal]).toEqual(["NoKeptDisk", words.noKeptDisk(web.id)]);
      const kept = await run(registry.delete(web.id));

      expect(await run(registry.forget(web.id))).toEqual(kept);
      expect(rows()).toEqual([]);
    }));
});

describe("reading the registry", () => {
  it("lists live ones default first then by name, kept ones last deleted first, and all by when they were made", () =>
    fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.constantFrom("ant", "bee", "cat", "dog", "eel"), { minLength: 1, maxLength: 5 }), fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }), (names, deleted) =>
        registryWith(async ({ registry, run, at }) => {
          let clock = T;

          for (const name of names) {
            clock += 10;
            await at(clock);
            await run(registry.create({ name }, () => false));
          }

          for (const [n, made] of (await run(registry.all)).entries()) {
            if (!deleted[n]) continue;
            clock += 10;
            await at(clock);
            await run(registry.delete(made.id));
          }

          const all = await run(registry.all);
          const live = all.filter((each) => each.deletedAt === null);

          const made = all.map((each) => each.createdAt);

          expect(made).toEqual([...made].sort((a, b) => a - b));
          expect((await run(registry.live)).map((each) => each.name)).toEqual([...live].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (a.name < b.name ? -1 : 1)).map((each) => each.name));
          expect((await run(registry.kept)).map((each) => each.deletedAt)).toEqual(all.flatMap((each) => (each.deletedAt === null ? [] : [each.deletedAt])).sort((a, b) => b - a));
        })
      ),
      runs()
    ));

  it("finds a repo's owner in any spelling, and answers reposFor as its repos, all for none, null when not live", () =>
    registryWith(async ({ registry, run }) => {
      const api = await run(registry.create({ name: "api", repos: ["acme/api"] }, () => false));
      const any = await run(registry.create({ name: "any" }, () => false));

      expect((await run(registry.owner("  ACME/Api ")))?.id).toBe(api.id);
      expect(await run(registry.reposFor(api.id))).toEqual(["acme/api"]);
      expect(await run(registry.reposFor(any.id))).toBe("all");
      expect(await run(registry.reposFor("sb-nope"))).toBeNull();
      expect((await run(registry.named("any")))?.id).toBe(any.id);
      expect(await run(registry.named("none"))).toBeUndefined();
    }));

  it("reads a repos cell a restore damaged as no repos", () =>
    registryWith(async ({ registry, run, db }) => {
      const web = await run(registry.create({ name: "web", repos: ["acme/web"] }, () => false));
      db.prepare("UPDATE ky_sandboxes SET repos = 'not json' WHERE id = ?").run(web.id);

      expect((await run(registry.get(web.id)))?.repos).toEqual([]);
      expect(await run(registry.reposFor(web.id))).toBe("all");
    }));

  it("skips a row a restore damaged", () =>
    registryWith(async ({ registry, run, db }) => {
      const web = await run(registry.create({ name: "web" }, () => false));
      const api = await run(registry.create({ name: "api" }, () => false));
      db.prepare("UPDATE ky_sandboxes SET created_at = 'soon' WHERE id = ?").run(web.id);

      expect((await run(registry.all)).map((each) => each.id)).toEqual([api.id]);
      expect(await run(registry.get(web.id))).toBeUndefined();
      expect(await run(registry.named("web"))).toBeUndefined();
    }));
});

describe("seeding and restoring", () => {
  it("makes the cloud machine the default sandbox once, at the Clock's time, only into an empty registry", () =>
    registryWith(async ({ registry, run, at, db }) => {
      await at(T + 7);
      await run(registry.migrate);

      expect(await run(registry.all)).toEqual([{ id: "cloud", name: "cloud", repos: [], idleMinutes: null, isDefault: true, createdAt: T + 7, deletedAt: null }]);
      expect(db.prepare(`SELECT at FROM ${RUNNER_TABLES.seeded}`).all()).toEqual([{ at: T + 7 }]);
      await run(registry.delete("cloud"));
      await run(registry.forget("cloud"));
      await run(registry.migrate);
      expect(await run(registry.all)).toEqual([]);
    }));

  it("seeds no cloud machine into a registry that has sandboxes", () =>
    registryWith(async ({ registry, run }) => {
      await run(registry.create({ name: "web" }, () => false));
      await run(registry.migrate);

      expect((await run(registry.all)).map((each) => each.name)).toEqual(["web"]);
      await run(registry.migrate);
      expect(await run(registry.all)).toHaveLength(1);
    }));

  it("marks the registry seeded once, at the Clock's latest time", () =>
    registryWith(async ({ registry, run, at, db }) => {
      await run(registry.seeded);
      await at(T + 3);
      await run(registry.seeded);

      expect(db.prepare(`SELECT at FROM ${RUNNER_TABLES.seeded}`).all()).toEqual([{ at: T + 3 }]);
      await run(registry.migrate);
      expect(await run(registry.all)).toEqual([]);
    }));

  it("keeps lost sandboxes as kept disks, deleted now unless they already were, and never over one it has", () =>
    registryWith(async ({ registry, run, at }) => {
      const web = await run(registry.create({ name: "web" }, () => false));
      await at(T + 60);
      await run(
        registry.keep([
          sandbox(web.id, { name: "other" }),
          sandbox("sb-live", { repos: ["acme/x"], idleMinutes: 9, isDefault: true }),
          sandbox("sb-gone", { deletedAt: T - 50 })
        ])
      );

      expect(await run(registry.get(web.id))).toEqual(web);
      expect(await run(registry.get("sb-live"))).toEqual(sandbox("sb-live", { repos: ["acme/x"], idleMinutes: 9, isDefault: false, deletedAt: T + 60 }));
      expect((await run(registry.get("sb-gone")))?.deletedAt).toBe(T - 50);
    }));

  it("keeps the cloud machine's save at its old key and every other under its id", () =>
    fc.assert(
      fc.property(fc.string(), (id) => {
        expect(saveKey(id)).toBe(id === "cloud" ? "cloud-machine/save.tar.gz" : `cloud-machine/${id}/save.tar.gz`);
      })
    ));
});

type Routes = { readonly world: World; readonly route: (request: Request) => Promise<{ status: number; body: string }>; readonly at: (ms: number) => Promise<void> };

async function routesWith(test: (routes: Routes) => Promise<void>): Promise<void> {
  const world = new World(next, { now: () => DATE });
  const runtime = ManagedRuntime.make(TestClock.layer());

  const route = async (request: Request) => {
    const url = new URL(request.url);
    const program = tokenRoute(request, world.env, url) ?? ownerRoute(request, world.env, url);

    if (!program) throw new Error(`No route for ${url.pathname}`);
    const response = await runtime.runPromise(program.pipe(Effect.catch((refused: RouteRefused) => Effect.succeed(new Response(refused.refusal, { status: refused.status })))));

    return { status: response.status, body: await response.text() };
  };

  try {
    await runtime.runPromise(TestClock.setTime(T));
    await test({ world, route, at: (ms) => runtime.runPromise(TestClock.setTime(ms)) });
  } finally {
    await runtime.dispose();
    world.db.close();
  }
}

const ORIGIN = "https://ky.test";

const UUID = "00000001-0000-4000-8000-000000000000";

const PNG = { "Content-Type": "image/png", "Content-Length": "8", "X-Ky-Name": "shot.png" };

function socket(machine: string, token?: string, upgrade = true): Request {
  const headers = new Headers();

  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);

  if (upgrade) headers.set("Upgrade", "websocket");

  return new Request(`${ORIGIN}/runner/${machine}`, { headers });
}

const pairing = (body: string, ip = "1.2.3.4") => new Request(`${ORIGIN}/api/runners/pair`, { method: "POST", headers: { "CF-Connecting-IP": ip }, body });

const asked = (body: { code: string; name: string; facts: Json }) => JSON.stringify(body);

const Paired = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ machine: Schema.String, token: Schema.String })));

const Code = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ code: Schema.String, expiresAt: Schema.Number })));

const SENT = { status: 400, body: "Send { code, name, facts }; a name is lowercase letters, digits and dashes, up to 32." };

const NOT_FACTS = { status: 400, body: "facts is not what a runner says about its machine." };

describe("a runner's socket", () => {
  it("opens only for its own machine's token, says 401 before 426, and hands the agent the pairing, never the token", () =>
    routesWith(async ({ world, route }) => {
      expect(await route(socket("box", MACHINE_TOKEN))).toEqual({ status: 401, body: "Unauthorized" });
      expect(await route(socket("mini"))).toEqual({ status: 401, body: "Unauthorized" });
      expect(await route(socket("mini", TASK_TOKEN))).toEqual({ status: 401, body: "Unauthorized" });
      expect(await route(socket("mini", MACHINE_TOKEN, false))).toEqual({ status: 426, body: "Upgrade Required" });
      expect(await route(socket("Mini", MACHINE_TOKEN))).toEqual({ status: 404, body: "Not found" });
      const opened = await route(socket("mini", MACHINE_TOKEN));

      expect(opened.status).toBe(200);
      expect(JSON.parse(opened.body)).toEqual({ url: `${ORIGIN}/runner/mini`, pairing: "p1", authorization: null, upgrade: "websocket" });
      expect(world.effects).toEqual([{ socket: { url: `${ORIGIN}/runner/mini`, pairing: "p1", authorization: null, upgrade: "websocket" } }]);
    }));
});

describe("pairing a machine", () => {
  it("takes only a POST, within the address's limit", () =>
    routesWith(async ({ world, route }) => {
      expect(await route(new Request(`${ORIGIN}/api/runners/pair`))).toEqual({ status: 405, body: "Method not allowed" });
      expect(await route(pairing(asked({ code: "live-code", name: "box", facts: FACTS }), "flood"))).toEqual({ status: 429, body: "Too many pairing attempts; wait a minute." });
      expect(world.effects).toEqual([{ limit: "flood" }]);
    }));

  it("refuses a body that isn't { code, name, facts } with a runner's facts, before it spends the code", () =>
    fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom("", "not json", "null", "[]", "{}", '{"code":"live-code","name":"box"}').map((body) => ({ body, answer: SENT })),
          fc
            .record({ code: fc.constantFrom("live-code", ""), name: fc.constantFrom("Box", "-x", "x".repeat(33), "box"), facts: fc.constant<Json>(FACTS) })
            .filter(({ code, name }) => code === "" || name !== "box")
            .map((body) => ({ body: asked(body), answer: SENT })),
          fc.constantFrom<Json>(null, { ...FACTS, kind: "phone" }, {}, "darwin").map((facts) => ({ body: asked({ code: "live-code", name: "box", facts }), answer: NOT_FACTS }))
        ),
        ({ body, answer }) =>
          routesWith(async ({ world, route }) => {
            expect(await route(pairing(body))).toEqual(answer);
            expect(world.tokens.has("live-code")).toBe(true);
          })
      ),
      runs()
    ));

  it("refuses a sandbox's name, and a wrong, used or expired code", () =>
    routesWith(async ({ world, route }) => {
      world.registry.create({ name: "lab" }, () => false);

      expect(await route(pairing(asked({ code: "live-code", name: "lab", facts: FACTS })))).toEqual({ status: 409, body: "lab is one of ky's sandboxes; pick another name." });

      for (const code of ["nope", "old-code", MACHINE_TOKEN]) {
        expect(await route(pairing(asked({ code, name: "box", facts: FACTS })))).toEqual({ status: 401, body: "That code is wrong, used or expired. Make a new one in ky." });
      }

      expect(world.machines.has("box")).toBe(false);
    }));

  it("spends the code once, gives a token for a new pairing, and revokes the machine's last pairing", () =>
    routesWith(async ({ world, route }) => {
      const paired = await route(pairing(asked({ code: "live-code", name: "mini", facts: FACTS })));
      const { machine, token } = Paired(paired.body);
      const pairingId = world.machines.get("mini");

      expect([paired.status, machine]).toEqual([200, "mini"]);
      expect(world.tokens.get(token)).toEqual({ kind: "machine", subject: `mini:${pairingId}`, expiresAt: null });
      expect(world.tokens.has(MACHINE_TOKEN)).toBe(false);
      expect(pairingId).not.toBe("p1");
      expect((await route(pairing(asked({ code: "live-code", name: "box", facts: FACTS })))).status).toBe(401);
      expect((await route(socket("mini", token))).status).toBe(200);
    }));

  it("revokes the token it minted when the agent refuses the pairing", () =>
    routesWith(async ({ world }) => {
      world.registry.create({ name: "lab" }, () => false);
      await expect(pairAs(world.env, "lab", FACTS, "sb-other")).rejects.toThrow("The sandbox sb-other is not lab now.");
      expect([...world.tokens.values()].flatMap((row) => (row.kind === "machine" ? [row.subject] : []))).toEqual(["mini:p1"]);
      expect(world.effects.at(-1)).toEqual({ revoke: "machine", subject: `lab:${UUID.replace("1", "2")}` });
    }));
});

describe("pairing codes", () => {
  it("makes a single-use code for ten minutes from the Clock, only on POST", () =>
    routesWith(async ({ world, route, at }) => {
      await at(T + 11);
      const made = await route(new Request(`${ORIGIN}/api/runners/codes`, { method: "POST" }));
      const { code, expiresAt } = Code(made.body);

      expect(expiresAt).toBe(T + 11 + CODE_TTL_MS);
      expect(world.effects).toEqual([{ mint: "pair", subject: UUID, ttlMs: CODE_TTL_MS }]);
      expect(world.tokens.get(code)?.kind).toBe("pair");
      expect(await route(new Request(`${ORIGIN}/api/runners/codes`))).toEqual({ status: 405, body: "Method not allowed" });
    }));
});

describe("removing a machine", () => {
  it("refuses a sandbox, a bad name or an unknown machine, and revokes a removed machine's pairing", () =>
    routesWith(async ({ world, route }) => {
      world.registry.create({ name: "lab" }, () => false);
      const remove = (machine: string) => route(new Request(`${ORIGIN}/api/runners/${machine}`, { method: "DELETE" }));

      expect(await remove("lab")).toEqual({ status: 409, body: "lab is one of ky's sandboxes: delete it in Settings, under Machines." });
      expect(await remove("Bad")).toEqual({ status: 404, body: "Not found" });
      expect(await remove("box")).toEqual({ status: 404, body: "No machine box." });
      expect(await remove("mini")).toEqual({ status: 204, body: "" });
      expect(world.tokens.has(MACHINE_TOKEN)).toBe(false);
      expect(world.machines.has("mini")).toBe(false);
    }));
});

describe("a task's upload", () => {
  it("takes a file only with its own task's token", () =>
    routesWith(async ({ world, route }) => {
      const upload = (task: string | undefined, token: string | undefined) =>
        route(
          new Request(`${ORIGIN}/api/files${task ? `?task=${task}` : ""}`, {
            method: "PUT",
            headers: token ? { ...PNG, Authorization: `Bearer ${token}` } : PNG,
            body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          })
        );

      for (const [task, token] of [["t2", TASK_TOKEN], ["t1", undefined], [undefined, TASK_TOKEN], ["mini:p1", MACHINE_TOKEN]] as const) {
        expect(await upload(task, token)).toEqual({ status: 401, body: "Unauthorized" });
      }

      expect(world.effects).toEqual([]);
      const taken = await upload("t1", TASK_TOKEN);

      expect(taken.status).toBe(200);
      const id = UUID.replaceAll("-", "");

      expect(world.effects).toEqual([
        { put: `files/${id}`, size: 8, contentType: "image/png" },
        { attachFile: { id, task: "t1", name: "shot.png", type: "image/png", size: 8, caption: null } }
      ]);
    }));
});

const runnersParity: Parity<Action> = {
  domain: "runners",
  actions,
  start: T,
  advances: fc.constantFrom(1_000, 60_000, 5 * 60_000, 11 * 60_000),
  legacy: async (clock) => instanceOf(legacy, clock),
  next: async (clock) => instanceOf(next, clock),
  divergences: [
    {
      name: "a row with a column of the wrong kind is skipped",
      covers: (action) => action.kind === "damage",
      heldBy: "test/invariants/runners.test.ts > skips a row a restore damaged"
    }
  ]
};

describe("runners parity", () => {
  it("answers as B did over generated runs", async () => {
    await assertParity(runnersParity);
  }, 600_000);
});
