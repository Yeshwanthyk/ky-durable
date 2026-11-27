import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import { Cloudflare } from "../../cli/cloudflare.ts";
import { type Context, deployCommand } from "../../cli/commands.ts";
import { overlayFor, readOverlay, writeOverlay } from "../../cli/config.ts";
import { initCommand } from "../../cli/init.ts";
import type { Release } from "../../cli/release.ts";
import { earlierKy, type FakeAccount, type FakeApp, type FakeCloudflare, type FakeScript, fakeAccount, fakeCloudflare } from "../fakes/cloudflare.ts";
import { fakeSystem } from "../fakes/system.ts";
import { budget } from "../parity/kit.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

const encode = (text: string) => new TextEncoder().encode(text);

const BASE = experimental_readRawConfig({ config: path.join(REPO, "wrangler.jsonc") }).rawConfig;

type Migrations = NonNullable<Unstable_RawConfig["migrations"]>;

const MIGRATIONS: Migrations = BASE.migrations ?? [];

function release(version: string, migrations: Migrations): Release {
  return {
    version,
    bundle: `sha256:${version}`,
    config: { ...BASE, main: "index.js", migrations },
    modules: new Map([
      ["index.js", encode(`export default {} // ${version}`)],
      ["assets/models.js", encode("export const models = []")]
    ]),
    assets: new Map([
      ["/index.html", encode(`<!doctype html><!-- ${version} -->`)],
      ["/manifest.webmanifest", encode("{}")]
    ]),
    skill: "# ky"
  };
}

const RELEASES = {
  old: release("r0", MIGRATIONS.slice(0, -1)),
  now: release("r1", MIGRATIONS),
  next: release("r2", [...MIGRATIONS, { tag: "v99", new_sqlite_classes: ["Ledger"] }])
};

type Version = keyof typeof RELEASES;

const ORDER = RELEASES.next.config.migrations?.map((migration) => migration.tag) ?? [];

const EMAIL = "owner@example.com";

function foreign(account: FakeAccount, squatter: boolean): FakeAccount {
  const theirs: FakeScript = {
    tags: ["billing"],
    migrations: [],
    metadata: { main_module: "index.js", bindings: [{ type: "r2_bucket", name: "B", bucket_name: "theirs" }] },
    modules: ["index.js"],
    secrets: new Map([["STRIPE", "sk"]]),
    workersDev: true
  };

  const app: FakeApp = {
    id: "intranet",
    aud: "aud-intranet",
    name: "intranet",
    type: "self_hosted",
    destinations: [{ type: "public", uri: "intranet.example.com" }],
    policies: [{ name: "staff", decision: "allow", include: [{ everyone: {} }] }]
  };

  account.scripts.set("billing", theirs);

  if (squatter) account.scripts.set("ky", { ...theirs, tags: [] });
  account.buckets.set("theirs", new Set(["invoice.pdf"]));
  account.apps.set(app.id, app);

  return account;
}

const byName = <T>(entries: Iterable<[string, T]>): [string, T][] => [...entries].sort(([a], [b]) => a.localeCompare(b));

const sorted = (values: Iterable<string>): string[] => [...values].sort((a, b) => a.localeCompare(b));

const scriptData = (script: FakeScript) => ({ ...script, secrets: byName(script.secrets) });

function snapshot(account: FakeAccount): string {
  const { id, name, subdomain, team, paid } = account;
  const scripts = byName(account.scripts).map(([script, each]) => [script, { ...scriptData(each), metadata: { ...each.metadata, migrations: undefined } }]);
  const buckets = byName(account.buckets).map(([bucket, keys]) => [bucket, sorted(keys)]);

  return JSON.stringify(
    { id, name, subdomain, team, paid, scripts, buckets, apps: byName(account.apps), tags: sorted(account.tags), containerApps: byName(account.containerApps), zones: byName(account.zones) },
    null,
    1
  );
}

function difference(expected: string, actual: string): string {
  const [want, got] = [expected.split("\n"), actual.split("\n")];
  const at = want.findIndex((line, index) => line !== got[index]);

  if (at === -1 && want.length === got.length) return "";
  const line = at === -1 ? want.length : at;
  const around = want.slice(Math.max(0, line - 4), line).map((each) => each.trim());

  return `after ${around.join(" ")}: expected ${want[line]?.trim() ?? "(end)"}, got ${got[line]?.trim() ?? "(end)"}`;
}

const archive = (): FakeScript => ({
  tags: ["archive"],
  migrations: [],
  metadata: { main_module: "index.js", bindings: [{ type: "r2_bucket", name: "FILES", bucket_name: "ky-files" }] },
  modules: ["index.js"],
  secrets: new Map(),
  workersDev: false
});

type World = { fake: FakeCloudflare; account: FakeAccount; release: Release };

async function world(squatter = false): Promise<World> {
  const account = foreign(fakeAccount("acc", "Test", { subdomain: "test", team: "test.cloudflareaccess.com" }), squatter);

  return { fake: await fakeCloudflare(account), account, release: RELEASES.now };
}

let overlay: string;

function context(at: World): Context {
  return {
    system: system,
    env: {},
    sleep: async () => {},
    overlay,
    release: async () => at.release,
    login: async () => new Cloudflare("test-token", "CLOUDFLARE_API_TOKEN"),
    print: () => {},
    fail: () => {},
    stdin: async () => undefined
  };
}

let system: Awaited<ReturnType<typeof fakeSystem>>;

async function deploy(at: World, version: Version, cut?: number): Promise<{ ok: boolean; writes: string[]; last: string }> {
  const before = at.fake.requests.length;

  at.release = RELEASES[version];
  at.fake.cut = cut === undefined ? undefined : at.fake.served + cut;
  process.env.CLOUDFLARE_API_BASE_URL = at.fake.url;
  let ok: boolean;

  try {
    ok = (await deployCommand(context(at))) === 0;
  } catch {
    ok = false;
  } finally {
    at.fake.cut = undefined;
  }

  const made = at.fake.requests.slice(before);

  return { ok, writes: made.filter((request) => !request.startsWith("GET ")), last: made.at(-1) ?? "nothing" };
}

async function length(before: Version[], version: Version): Promise<number> {
  const at = await world();

  for (const each of before) await deploy(at, each);
  const start = at.fake.served;

  await deploy(at, version);
  await at.fake.close();

  return at.fake.served - start;
}

async function after(before: Version[]): Promise<World> {
  const at = await world();

  for (const each of before) expect((await deploy(at, each)).ok, `deploy ${each}`).toBe(true);

  return at;
}

function trespasses(start: FakeAccount, now: FakeAccount): string[] {
  return [...foreignChanged(start, now), ...untaggedMade(start, now)];
}

const same = <T,>(a: T, b: T | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** Whether a deploy, today's or an earlier ky's, marked it as its own. */
const ourTags = (tags: readonly string[] | undefined) => ["self-hosted-agent", "ky"].some((tag) => tags?.includes(tag));

const ourBucket = (keys: Set<string>) => keys.has(".self-hosted-agent") || keys.has(".ky");

function foreignChanged(start: FakeAccount, now: FakeAccount): string[] {
  const workers = [...start.scripts].filter(([name, script]) => !ourTags(script.tags) && !same(scriptData(script), mapOr(now.scripts.get(name), scriptData)));
  const buckets = [...start.buckets].filter(([name, keys]) => !ourBucket(keys) && !same(sorted(keys), sorted(now.buckets.get(name) ?? ["(gone)"])));
  const apps = [...start.apps].filter(([id, app]) => !ourTags(app.tags) && !same(app, now.apps.get(id)));

  return [
    ...workers.map(([name]) => `changed someone else's Worker ${name}`),
    ...buckets.map(([name]) => `changed someone else's bucket ${name}`),
    ...apps.map(([id]) => `changed someone else's Access app ${id}`)
  ];
}

function untaggedMade(start: FakeAccount, now: FakeAccount): string[] {
  const workers = [...now.scripts].filter(([name, script]) => !start.scripts.has(name) && !script.tags.includes("self-hosted-agent"));
  const apps = [...now.apps].filter(([id, app]) => !start.apps.has(id) && !app.tags?.includes("self-hosted-agent"));

  return [...workers.map(([name]) => `made Worker ${name} without the self-hosted-agent tag`), ...apps.map(([id]) => `made Access app ${id} without the self-hosted-agent tag`)];
}

function mapOr<T, U>(value: T | undefined, f: (value: T) => U): U | undefined {
  return value === undefined ? undefined : f(value);
}

function copy(account: FakeAccount): FakeAccount {
  return structuredClone(account);
}

beforeAll(async () => {
  system = await fakeSystem();
  overlay = path.join(await mkdtemp(path.join(tmpdir(), "ky-deploy-invariants-")), "wrangler.local.jsonc");
  const at = await world();

  process.env.CLOUDFLARE_API_BASE_URL = at.fake.url;
  expect(await initCommand(context(at), { account: "Test", name: "ky", email: EMAIL })).toBe(0);
  await at.fake.close();
});

afterAll(() => {
  delete process.env.CLOUDFLARE_API_BASE_URL;
});

describe("ky deploy, on any account", () => {
  it("I-D2: deploys the same release a second time without changing the account, and with reads only", async () => {
    const writes = new Set<string>();

    for (const history of [["now"], ["now", "next"]] satisfies Version[][]) {
      const at = await after(history);
      const first = snapshot(at.account);
      const again = await deploy(at, history.at(-1) ?? "now");

      expect(again.ok).toBe(true);
      expect(difference(first, snapshot(at.account)), `after ${history.join(", ")}`).toBe("");

      for (const write of again.writes) writes.add(write.replace(/access\/apps\/[^/]+$/, "access/apps/:id"));
      await at.fake.close();
    }

    expect([...writes].sort()).toEqual([]);
  });

  it("I-D6: a deploy after the overlay changed leaves the Worker running it, even of the same release", async () => {
    const at = await after(["now"]);
    const saved = overlay;
    const emails = `${EMAIL},friend@example.com`;

    overlay = path.join(path.dirname(saved), "wrangler.changed.jsonc");
    await writeOverlay(overlay, overlayFor((await readOverlay(saved)) ?? {}, "acc", "ky", emails));

    try {
      expect((await deploy(at, "now")).ok).toBe(true);
    } finally {
      overlay = saved;
      await at.fake.close();
    }

    const bindings = at.account.scripts.get("ky")?.metadata.bindings ?? [];

    expect(bindings.find((binding) => binding.name === "ACCESS_EMAILS")).toMatchObject({ type: "plain_text", text: emails });
  });

  it("I-D7: a bucket ky didn't mark is adopted only when it's empty and unbound; else the deploy refuses and leaves it", async () => {
    for (const [keys, bound] of [
      [[], false],
      [["notes.txt"], false],
      [[], true],
      [["notes.txt"], true]
    ] satisfies [string[], boolean][]) {
      const at = await world();
      const where = `a bucket with ${keys.length} objects, ${bound ? "" : "not "}bound by another Worker`;

      at.account.buckets.set("ky-files", new Set(keys));

      if (bound) at.account.scripts.set("archive", archive());
      const { ok } = await deploy(at, "now");
      const now = sorted(at.account.buckets.get("ky-files") ?? []);

      await at.fake.close();

      if (keys.length === 0 && !bound) {
        expect(ok, where).toBe(true);
        expect(now, where).toEqual([".self-hosted-agent"]);
      } else {
        expect(ok, where).toBe(false);
        expect(now, where).toEqual(keys);
      }
    }
  });

  it("I-D3: a deploy cut off after any request, then run again, ends where a clean deploy does", async () => {
    const broken = new Set<string>();

    for (const [before, version] of [
      [[], "now"],
      [["now"], "next"]
    ] satisfies [Version[], Version][]) {
      const clean = await after([...before, version]);
      const expected = snapshot(clean.account);
      const requests = await length(before, version);
      const history = `${version} after ${before.join(", ") || "nothing"}`;

      await clean.fake.close();
      expect(requests).toBeGreaterThan(5);

      for (let k = 0; k < requests; k++) {
        const at = await after(before);
        const { last } = await deploy(at, version, k);
        const rerun = await deploy(at, version);
        const where = `${history}, cut after ${last}`;

        if (!rerun.ok) broken.add(`${where}: the rerun fails`);
        else {
          const different = difference(expected, snapshot(at.account));

          if (different) broken.add(`${where}: ${different}`);
        }

        await at.fake.close();
      }
    }

    expect([...broken].sort()).toEqual([]);
  });

  it("I-D8: a ky an earlier release deployed is moved over; cut off after any request, its bucket keeps a marker and the rerun converges", async () => {
    const earlier = async () => {
      const at = await after(["now"]);

      at.account.buckets.get("ky-files")?.add("chat/a.png");
      earlierKy(at.account);

      return at;
    };

    const clean = await earlier();
    const start = copy(clean.account);
    const before = clean.fake.served;

    expect((await deploy(clean, "now")).ok).toBe(true);
    const expected = snapshot(clean.account);
    const requests = clean.fake.served - before;

    await clean.fake.close();
    expect(clean.account.scripts.get("ky")?.tags).toEqual(["self-hosted-agent", "self-hosted-agent-release-r1"]);
    expect([...clean.account.apps.values()].flatMap((app) => (app.name.startsWith("ky") ? [app.tags] : []))).toEqual([["self-hosted-agent"], ["self-hosted-agent"]]);
    expect(sorted(clean.account.buckets.get("ky-files") ?? [])).toEqual([".self-hosted-agent", "chat/a.png"]);
    expect(trespasses(start, clean.account)).toEqual([]);

    const broken = new Set<string>();

    for (let k = 0; k < requests; k++) {
      const at = await earlier();
      const { last } = await deploy(at, "now", k);
      const keys = new Set(at.account.buckets.get("ky-files"));
      const rerun = await deploy(at, "now");
      const where = `cut after ${last}`;

      if (!keys.has(".ky") && !keys.has(".self-hosted-agent")) broken.add(`${where}: the bucket has no marker`);

      if (!rerun.ok) broken.add(`${where}: the rerun fails`);
      else {
        const different = difference(expected, snapshot(at.account));

        if (different) broken.add(`${where}: ${different}`);
      }

      await at.fake.close();
    }

    expect([...broken].sort()).toEqual([]);
  });

  it("I-D1, I-D3, I-D4, I-D5 hold through any run of deploys, cuts and secrets", async () => {
    type Model = { secrets: Map<string, string> };

    type Real = { at: World; shadow: World; start: FakeAccount };

    const check = (real: Real, model: Model) => {
      const ky = real.at.account.scripts.get("ky");

      expect(trespasses(real.start, real.at.account)).toEqual([]);

      if (!ky?.tags.includes("self-hosted-agent")) return;

      const order = ky.migrations.map((migration) => ORDER.indexOf(migration.new_tag ?? ""));

      expect(new Set(order).size, `migrations uploaded: ${order.join(", ")}`).toBe(order.length);
      expect(order).toEqual([...order].sort((a, b) => a - b));

      for (const [name, value] of model.secrets) expect(ky.secrets.get(name), `secret ${name}`).toBe(value);
    };

    const Deploy = (version: Version, cut: number | undefined): fc.AsyncCommand<Model, Real> => ({
      check: () => true,
      run: async (model, real) => {
        const tagBefore = ORDER.indexOf(real.at.account.scripts.get("ky")?.migrationTag ?? "");

        if (cut !== undefined) await deploy(real.at, version, cut);

        const done = await deploy(real.at, version);
        const shadow = await deploy(real.shadow, version);

        expect(done.ok).toBe(shadow.ok);
        expect(difference(snapshot(real.shadow.account), snapshot(real.at.account))).toBe("");
        expect(ORDER.indexOf(real.at.account.scripts.get("ky")?.migrationTag ?? "")).toBeGreaterThanOrEqual(tagBefore);
        check(real, model);
      },
      toString: () => (cut === undefined ? `deploy ${version}` : `deploy ${version} cut after ${cut}, then again`)
    });

    const Secret = (name: string, value: string): fc.AsyncCommand<Model, Real> => ({
      check: () => true,
      run: async (model, real) => {
        const mine = real.at.account.scripts.get("ky");
        const theirs = real.shadow.account.scripts.get("ky");

        if (!mine?.tags.includes("self-hosted-agent") || !theirs?.tags.includes("self-hosted-agent")) return;

        mine.secrets.set(name, value);
        theirs.secrets.set(name, value);
        model.secrets.set(name, value);
        check(real, model);
      },
      toString: () => `wrangler secret put ${name}=${value}`
    });

    const version = fc.constantFrom<Version>("old", "now", "next");

    const commands = fc.commands(
      [
        version.map((each) => Deploy(each, undefined)),
        fc.tuple(version, fc.nat({ max: 40 })).map(([each, cut]) => Deploy(each, cut)),
        fc.tuple(fc.constantFrom("OPENAI_KEY", "GITHUB_TOKEN"), fc.string({ minLength: 1, maxLength: 4 })).map(([name, value]) => Secret(name, value))
      ],
      { maxCommands: Math.min(budget().maxCommands, 12) }
    );

    const { numRuns, seed } = budget();

    await fc.assert(
      fc.asyncProperty(fc.oneof({ arbitrary: fc.constant(false), weight: 7 }, { arbitrary: fc.constant(true), weight: 1 }), commands, async (squatter, run) => {
        const at = await world(squatter);
        const shadow = await world(squatter);
        const real = { at, shadow, start: copy(at.account) };

        try {
          await fc.asyncModelRun(() => ({ model: { secrets: new Map() }, real }), run);
        } finally {
          await at.fake.close();
          await shadow.fake.close();
        }
      }),
      { numRuns, seed }
    );
  }, 600_000);
});
