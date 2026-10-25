/**
 * What `ky deploy` must never do to an account, checked against the fake Cloudflare
 * (test/fakes/cloudflare.ts) by looking only at the account, never at the deployer's code:
 *
 *   I-D1  it writes and deletes only what ky made: a Worker or Access app with the `ky` tag, a bucket
 *         with the `.ky` marker. Whatever else is on the account is left as it was.
 *   I-D2  a second deploy of the same release changes nothing: no request but reads.
 *   I-D3  a deploy cut off after any request k, then run again, leaves the account as one clean
 *         deploy does.
 *   I-D4  the Worker's migration tag only moves forward, and no migration is uploaded twice.
 *   I-D5  the Worker's secrets (`wrangler secret put`, the dashboard) survive every deploy.
 *
 * I-D3 is checked for every k of a first deploy and of an upgrade; the generated runs mix deploys of
 * three releases, cuts at any request, and the owner adding secrets, and hold all five after each.
 * `pnpm parity deploy` runs them at the bar: KY_RUNS (500), KY_SEED.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import { Cloudflare } from "../../cli/cloudflare.ts";
import { type Context, deployCommand } from "../../cli/commands.ts";
import { initCommand } from "../../cli/init.ts";
import type { Release } from "../../cli/release.ts";
import { type FakeAccount, type FakeApp, type FakeCloudflare, type FakeScript, fakeAccount, fakeCloudflare } from "../fakes/cloudflare.ts";
import { fakeSystem } from "../fakes/system.ts";
import { budget } from "../parity/kit.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

const encode = (text: string) => new TextEncoder().encode(text);

const BASE = experimental_readRawConfig({ config: path.join(REPO, "wrangler.jsonc") }).rawConfig;

type Migrations = NonNullable<Unstable_RawConfig["migrations"]>;

const MIGRATIONS: Migrations = BASE.migrations ?? [];

/** A release of ky's real wrangler.jsonc with `migrations`, and a stand-in Worker and web app. */
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

/** An older ky, today's, and a newer one that adds a Durable Object class. */
const RELEASES = {
  old: release("r0", MIGRATIONS.slice(0, -1)),
  now: release("r1", MIGRATIONS),
  next: release("r2", [...MIGRATIONS, { tag: "v99", new_sqlite_classes: ["Ledger"] }])
};

type Version = keyof typeof RELEASES;

/** The migration tags in the order they're made, for "only forward". */
const ORDER = RELEASES.next.config.migrations?.map((migration) => migration.tag) ?? [];

const EMAIL = "owner@example.com";

/**
 * Where B's deployer breaks an invariant, exactly as these tests observe it. The tests fail on a
 * breach not listed (a port broke deploy) and on a listed one that's gone (a port fixed it): move a
 * fixed one to docs/migration/effect/divergences/deploy.md, with the test that holds it.
 */
const B_BREACHES = {
  // A second deploy rewrites what's already there: the same content, but a new Worker version each time.
  "I-D2": ["PUT access/apps/:id", "POST workers/scripts/ky/assets-upload-session", "PUT workers/scripts/ky", "POST workers/scripts/ky/subdomain"],
  // Cut between making the bucket and writing its marker, ky refuses the bucket it made, forever.
  "I-D3": ["now after nothing, cut after POST r2/buckets: the rerun fails"]
};

/** The requests a cut may follow that B is known to break, for the generated runs to step around. */
const KNOWN_CUTS = new Set(["POST r2/buckets"]);

/** What a failing comparison with B_BREACHES means. */
const breaches = (invariant: keyof typeof B_BREACHES) =>
  `${invariant} breaches differ from B's: a new one means the change broke deploy; a listed one gone means it fixed one, so move it to the divergence list`;

/** What's on an account before ky ever deploys there: someone else's Worker, bucket and Access app. */
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

  // A Worker named as ky's, that `pnpm run deploy` made: ky must refuse it, not take it over.
  if (squatter) account.scripts.set("ky", { ...theirs, tags: [] });
  account.buckets.set("theirs", new Set(["invoice.pdf"]));
  account.apps.set(app.id, app);

  return account;
}

const byName = <T>(entries: Iterable<[string, T]>): [string, T][] => [...entries].sort(([a], [b]) => a.localeCompare(b));

const sorted = (values: Iterable<string>): string[] => [...values].sort((a, b) => a.localeCompare(b));

/** A Worker as plain data: its secrets in order. */
const scriptData = (script: FakeScript) => ({ ...script, secrets: byName(script.secrets) });

/**
 * The account as JSON, one key to a line, to compare and diff. A Worker's last upload carries the
 * migrations it ran only when it ran some, so a rerun after a cut uploads none: what they did is in
 * `migrationTag` and `migrations`, so the last upload's copy is left out. So are the asset hashes
 * uploaded: a cache of content by hash, which a cut run can leave more of without changing what the
 * Worker serves.
 */
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

/** Where two snapshots first differ, with the keys around it; "" when they don't. */
function difference(expected: string, actual: string): string {
  const [want, got] = [expected.split("\n"), actual.split("\n")];
  const at = want.findIndex((line, index) => line !== got[index]);

  if (at === -1 && want.length === got.length) return "";
  const line = at === -1 ? want.length : at;
  const around = want.slice(Math.max(0, line - 4), line).map((each) => each.trim());

  return `after ${around.join(" ")}: expected ${want[line]?.trim() ?? "(end)"}, got ${got[line]?.trim() ?? "(end)"}`;
}

/** A Cloudflare account behind the fake, and the overlay `ky init` wrote for it. */
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

/**
 * One `ky deploy` of `version` to the world, cut off after `cut` requests when set: whether it
 * succeeded, the requests that weren't reads, and the last request the account answered.
 */
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

/** How many requests a clean deploy of `version` makes to a world that's had `before`. */
async function length(before: Version[], version: Version): Promise<number> {
  const at = await world();

  for (const each of before) await deploy(at, each);
  const start = at.fake.served;

  await deploy(at, version);
  await at.fake.close();

  return at.fake.served - start;
}

/** The world after `before`, each deployed cleanly. */
async function after(before: Version[]): Promise<World> {
  const at = await world();

  for (const each of before) expect((await deploy(at, each)).ok, `deploy ${each}`).toBe(true);

  return at;
}

/** The I-D1 breaches in `now`: a foreign resource changed, or a resource ky left untagged. */
function trespasses(start: FakeAccount, now: FakeAccount): string[] {
  const found: string[] = [];

  for (const [name, script] of start.scripts) {
    const after = now.scripts.get(name);

    if (!script.tags.includes("ky") && JSON.stringify(scriptData(script)) !== JSON.stringify(after && scriptData(after))) found.push(`changed someone else's Worker ${name}`);
  }

  for (const [name, keys] of start.buckets)
    if (!keys.has(".ky") && sorted(keys).join("\n") !== sorted(now.buckets.get(name) ?? ["(gone)"]).join("\n")) found.push(`changed someone else's bucket ${name}`);

  for (const [id, app] of start.apps) if (!app.tags?.includes("ky") && JSON.stringify(app) !== JSON.stringify(now.apps.get(id))) found.push(`changed someone else's Access app ${id}`);

  for (const [name, script] of now.scripts) if (!start.scripts.has(name) && !script.tags.includes("ky")) found.push(`made Worker ${name} without the ky tag`);

  for (const [id, app] of now.apps) if (!start.apps.has(id) && !app.tags?.includes("ky")) found.push(`made Access app ${id} without the ky tag`);

  return found;
}

/** An account's state, deep-copied, to compare against later. */
function copy(account: FakeAccount): FakeAccount {
  return structuredClone(account);
}

beforeAll(async () => {
  system = await fakeSystem();
  overlay = path.join(await mkdtemp(path.join(tmpdir(), "ky-deploy-invariants-")), "wrangler.local.jsonc");
  const at = await world();

  // `ky init` against a fake, once, for the overlay every world shares.
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

    expect([...writes].sort(), breaches("I-D2")).toEqual([...B_BREACHES["I-D2"]].sort());
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

    expect([...broken].sort(), breaches("I-D3")).toEqual([...B_BREACHES["I-D3"]].sort());
  });

  it("I-D1, I-D3, I-D4, I-D5 hold through any run of deploys, cuts and secrets", async () => {
    type Model = { secrets: Map<string, string> };

    type Real = { at: World; shadow: World; start: FakeAccount };

    const check = (real: Real, model: Model) => {
      const ky = real.at.account.scripts.get("ky");

      expect(trespasses(real.start, real.at.account)).toEqual([]);

      if (!ky?.tags.includes("ky")) return;

      // I-D4: forward only, never a step twice.
      const order = ky.migrations.map((migration) => ORDER.indexOf(migration.new_tag ?? ""));

      expect(new Set(order).size, `migrations uploaded: ${order.join(", ")}`).toBe(order.length);
      expect(order).toEqual([...order].sort((a, b) => a - b));

      // I-D5
      for (const [name, value] of model.secrets) expect(ky.secrets.get(name), `secret ${name}`).toBe(value);
    };

    /** A deploy of `version`; with `cut`, one cut off there and run again, which I-D3 says is the same thing. */
    const Deploy = (version: Version, cut: number | undefined): fc.AsyncCommand<Model, Real> => ({
      check: () => true,
      run: async (model, real) => {
        const tagBefore = ORDER.indexOf(real.at.account.scripts.get("ky")?.migrationTag ?? "");

        if (cut !== undefined) {
          const { last } = await deploy(real.at, version, cut);

          // A cut in a window B is known to break is checked, exactly, by the I-D3 test above.
          fc.pre(!KNOWN_CUTS.has(last));
        }

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
      // The owner sets a secret on ky's Worker, in both histories.
      check: () => true,
      run: async (model, real) => {
        const mine = real.at.account.scripts.get("ky");
        const theirs = real.shadow.account.scripts.get("ky");

        if (!mine?.tags.includes("ky") || !theirs?.tags.includes("ky")) return;

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
      fc.asyncProperty(fc.boolean(), commands, async (squatter, run) => {
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
