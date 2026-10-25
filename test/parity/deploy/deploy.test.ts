/**
 * Deploy's parity runs: B's deployer (cli/deploy/legacy) and the port, each on its own fake Cloudflare
 * account built the same way, take the same generated actions (deploys of four releases, cut deploys
 * run again, doctor, teardown, and the owner or someone else changing the account between them) and
 * must answer alike, leave the accounts alike, and say the same steps. Scaffolding for the port:
 * deleted with cli/deploy/legacy once the proof is recorded.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import { Cloudflare } from "../../../cli/cloudflare.ts";
import { deployedPath, merged } from "../../../cli/config.ts";
import { Cloudflare as LegacyCloudflare } from "../../../cli/deploy/legacy/cloudflare.ts";
import * as Legacy from "../../../cli/deploy/legacy/deployer.ts";
import * as Port from "../../../cli/deploy/wiring.ts";
import type { Release } from "../../../cli/release.ts";
import { type FakeAccount, type FakeCloudflare, type FakeScript, fakeAccount, fakeCloudflare } from "../../fakes/cloudflare.ts";
import { assertParity, budget, type Instance, type Json, type Parity } from "../kit.ts";

const REPO = path.resolve(import.meta.dirname, "../../..");

const BASE = experimental_readRawConfig({ config: path.join(REPO, "wrangler.jsonc") }).rawConfig;

type Migrations = NonNullable<Unstable_RawConfig["migrations"]>;

const MIGRATIONS: Migrations = BASE.migrations ?? [];

const encode = (text: string) => new TextEncoder().encode(text);

function release(version: string, migrations: Migrations): Release {
  return {
    version,
    bundle: `sha256:${version}`,
    config: { ...BASE, main: "index.js", migrations },
    modules: new Map([["index.js", encode(`export default {} // ${version}`)]]),
    assets: new Map([["/index.html", encode(`<!doctype html><!-- ${version} -->`)]]),
    skill: "# ky"
  };
}

/** An older ky, today's, a newer one, and a build named by its commit, which always uploads. */
const RELEASES = {
  old: release("r0", MIGRATIONS.slice(0, -1)),
  now: release("r1", MIGRATIONS),
  next: release("r2", [...MIGRATIONS, { tag: "v99", new_sqlite_classes: ["Ledger"] }]),
  dev: release("1a2b3c4d", MIGRATIONS)
};

type Version = keyof typeof RELEASES;

const OVERLAY: Unstable_RawConfig = { name: "ky", account_id: "acc", vars: { ACCESS_EMAILS: "owner@example.com" } };

const BUCKETS = (BASE.r2_buckets ?? []).map((bucket) => `ky-${bucket.binding.toLowerCase()}`);

/**
 * Where a cut may fall: after a write both sides make whenever it's due (a pattern of the fake's request
 * lines), or as a step is said. A write the port skips because it's already done (I-D2) is cut at its
 * step instead, so both sides stop at the same point.
 */
const CUTS = [
  "^POST r2/buckets$",
  "^PUT r2/buckets/[^/]+/objects/",
  "^POST access/tags$",
  "^POST access/apps$",
  "Setting up the bucket",
  "Setting up Access",
  "Uploading the web app",
  "Upgrading the Worker",
  "Uploading the Worker",
  "Turning on workers.dev"
];

type Action =
  | { _tag: "deploy" | "inspect"; version: Version }
  | { _tag: "cut"; version: Version; after: string }
  | { _tag: "claim" | "address" | "deployedRelease" | "teardown" | "leftovers" | "squat" | "theirBucket" }
  | { _tag: "secret"; name: string; value: string }
  | { _tag: "zeroTrust" | "workersDev"; on: boolean };

const version = fc.constantFrom<Version>("old", "now", "next", "dev");

const actions: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: version.map((each) => ({ _tag: "deploy" as const, version: each })), weight: 6 },
  { arbitrary: fc.record({ _tag: fc.constant("cut" as const), version, after: fc.constantFrom(...CUTS) }), weight: 4 },
  { arbitrary: version.map((each) => ({ _tag: "inspect" as const, version: each })), weight: 2 },
  { arbitrary: fc.constantFrom("claim" as const, "address" as const, "deployedRelease" as const, "leftovers" as const).map((_tag) => ({ _tag })), weight: 2 },
  { arbitrary: fc.constant({ _tag: "teardown" as const }), weight: 1 },
  { arbitrary: fc.constantFrom("squat" as const, "theirBucket" as const).map((_tag) => ({ _tag })), weight: 1 },
  { arbitrary: fc.record({ _tag: fc.constant("secret" as const), name: fc.constantFrom("TOKEN", "KEY"), value: fc.constantFrom("a", "b") }), weight: 1 },
  { arbitrary: fc.record({ _tag: fc.constantFrom("zeroTrust" as const, "workersDev" as const), on: fc.boolean() }), weight: 1 }
);

const byName = <T>(entries: Iterable<[string, T]>): [string, T][] => [...entries].sort(([a], [b]) => a.localeCompare(b));

const sorted = (values: Iterable<string>): string[] => [...values].sort((a, b) => a.localeCompare(b));

/** The account as plain JSON; the last upload's copy of its migrations aside, as in the invariant tests. */
function snapshot(account: FakeAccount): Json {
  const scripts = byName(account.scripts).map(([name, each]) => [name, { ...each, secrets: byName(each.secrets), metadata: { ...each.metadata, migrations: undefined } }]);

  return JSON.parse(
    JSON.stringify({
      subdomain: account.subdomain,
      team: account.team,
      scripts,
      buckets: byName(account.buckets).map(([name, keys]) => [name, sorted(keys)]),
      apps: byName(account.apps),
      tags: sorted(account.tags),
      containerApps: byName(account.containerApps)
    })
  );
}

/** What both deployers do, over a target each side builds its own way. */
type Deployer = {
  deploy: (version: Version, say: (step: string) => void) => Promise<unknown>;
  inspect: (version: Version) => Promise<unknown>;
  claim: () => Promise<{ script: { id?: string | null } | undefined; address: string }>;
  address: () => Promise<string>;
  deployedRelease: () => Promise<string | undefined>;
  teardown: (say: (step: string) => void) => Promise<void>;
  leftovers: () => Promise<string[]>;
};

type Side = { fake: FakeCloudflare; account: FakeAccount; settings: string };

/** Both sides read the API's address when their login is made, so each makes it pointed at its own fake. */
function pointed<T>(fake: FakeCloudflare, make: () => T): T {
  process.env.CLOUDFLARE_API_BASE_URL = fake.url;

  return make();
}

function legacyDeployer(side: Side): Deployer {
  const target = (version: Version = "now") => ({
    cloudflare: pointed(side.fake, () => new LegacyCloudflare("test-token", "CLOUDFLARE_API_TOKEN")),
    config: merged(RELEASES[version], OVERLAY),
    settings: side.settings
  });

  return {
    deploy: (each, say) => Legacy.deploy(target(each), RELEASES[each], say),
    inspect: (each) => Legacy.inspect(target(each), RELEASES[each]),
    claim: () => Legacy.claim(target()),
    address: () => Legacy.address(target()),
    deployedRelease: () => Legacy.deployedRelease(target()),
    teardown: (say) => Legacy.teardown(target(), say),
    leftovers: () => Legacy.leftovers(target())
  };
}

function portDeployer(side: Side): Deployer {
  const target = (version: Version = "now") => ({
    cloudflare: pointed(side.fake, () => new Cloudflare("test-token", "CLOUDFLARE_API_TOKEN")),
    config: merged(RELEASES[version], OVERLAY),
    settings: side.settings
  });

  return {
    deploy: (each, say) => Port.deploy(target(each), RELEASES[each], say),
    inspect: (each) => Port.inspect(target(each), RELEASES[each]),
    claim: () => Port.claim(target()),
    address: () => Port.address(target()),
    deployedRelease: () => Port.deployedRelease(target()),
    teardown: (say) => Port.teardown(target(), say),
    leftovers: () => Port.leftovers(target())
  };
}

/** Someone else's Worker named as ky's would be. */
const squatter = (): FakeScript => ({ tags: ["billing"], migrations: [], metadata: { main_module: "index.js" }, modules: ["index.js"], secrets: new Map(), workersDev: false });

/** Changes the account as its owner or someone else would between deploys. */
function change(account: FakeAccount, action: Action): void {
  const ky = account.scripts.get("ky");

  if (action._tag === "squat" && !ky) account.scripts.set("ky", squatter());

  // Never an empty one: ky adopts an empty, unbound bucket of its name where B refused it (I-D3).
  if (action._tag === "theirBucket") for (const bucket of BUCKETS) if (!account.buckets.has(bucket)) account.buckets.set(bucket, new Set(["invoice.pdf"]));

  if (action._tag === "secret" && ky) ky.secrets.set(action.name, action.value);

  if (action._tag === "zeroTrust") account.team = action.on ? "test.cloudflareaccess.com" : undefined;

  if (action._tag === "workersDev") account.subdomain = action.on ? "test" : undefined;
}

const outcome = async (run: () => Promise<Json>): Promise<Json> => {
  try {
    return await run();
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
};

async function instance(make: (side: Side) => Deployer): Promise<Instance<Action>> {
  const account = fakeAccount("acc", "Test", { subdomain: "test", team: "test.cloudflareaccess.com" });
  const side: Side = { fake: await fakeCloudflare(account), account, settings: path.join(await mkdtemp(path.join(tmpdir(), "ky-deploy-parity-")), "wrangler.local.jsonc") };
  const deployer = make(side);
  const said: string[] = [];
  const say = (step: string) => said.push(step);

  const apply = async (action: Action): Promise<Json> => {
    switch (action._tag) {
      case "deploy":
        return outcome(async () => JSON.parse(JSON.stringify(await deployer.deploy(action.version, say))));
      case "cut": {
        // Cut off there, then run again: only the rerun is observed, as I-D3 says it's one deploy.
        const at = action.after.startsWith("^") ? undefined : action.after;

        side.fake.cutAfter = at ? undefined : new RegExp(action.after);
        await outcome(async () =>
          JSON.stringify(
            await deployer.deploy(action.version, (step) => {
              if (at && step.startsWith(at)) side.fake.cut = side.fake.served;
            })
          )
        );
        side.fake.cutAfter = undefined;
        side.fake.cut = undefined;

        return outcome(async () => JSON.parse(JSON.stringify(await deployer.deploy(action.version, say))));
      }
      case "inspect":
        return outcome(async () => JSON.parse(JSON.stringify(await deployer.inspect(action.version))));
      case "claim":
        return outcome(async () => {
          const claimed = await deployer.claim();

          return { script: claimed.script?.id ?? null, address: claimed.address };
        });
      case "address":
        return outcome(() => deployer.address());
      case "deployedRelease":
        return outcome(async () => (await deployer.deployedRelease()) ?? null);
      case "teardown":
        return outcome(async () => {
          await deployer.teardown(say);

          return null;
        });
      case "leftovers":
        return outcome(() => deployer.leftovers());
      default:
        change(account, action);

        return null;
    }
  };

  return {
    apply,
    tables: async () => snapshot(account),
    effects: async () => ({ said, deployed: await readFile(deployedPath(side.settings), "utf8").catch(() => null) }),
    dispose: () => side.fake.close()
  };
}

const deploy: Parity<Action> = {
  domain: "deploy",
  actions,
  legacy: () => instance(legacyDeployer),
  next: () => instance(portDeployer),
  // Each side keeps its settings in its own temporary folder, which refusals name.
  normalize: (observed) => JSON.parse(JSON.stringify(observed).replaceAll(/ky-deploy-parity-\w+/g, "ky-deploy-parity")),
  divergences: [
    {
      name: "a deploy cut between making its bucket and marking it is finished by the next, where B refused the bucket forever",
      covers: (action) => action._tag === "cut" && action.after === "^POST r2/buckets$",
      heldBy: "test/invariants/deploy.test.ts > I-D3: a deploy cut off after any request, then run again, ends where a clean deploy does"
    }
  ]
};

describe("deploy parity", () => {
  it("answers, leaves the account and says the steps as B did, but where it diverges on purpose", async () => {
    await assertParity(deploy);
  }, 3_600_000);

  it("upgrades a Worker B deployed without replaying a migration, to where the port alone would have it", async () => {
    const ORDER = RELEASES.next.config.migrations?.map((migration) => migration.tag) ?? [];

    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ by: fc.constantFrom("legacy", "port"), version }), { minLength: 1, maxLength: 6 }), async (history) => {
        const mixed = fakeAccount("acc", "Test", { subdomain: "test", team: "test.cloudflareaccess.com" });
        const alone = fakeAccount("acc", "Test", { subdomain: "test", team: "test.cloudflareaccess.com" });
        const sides = await Promise.all(
          [mixed, alone].map(async (account): Promise<Side> => ({ fake: await fakeCloudflare(account), account, settings: path.join(await mkdtemp(path.join(tmpdir(), "ky-deploy-parity-")), "wrangler.local.jsonc") }))
        );
        const [onMixed, onAlone] = sides;

        if (!onMixed || !onAlone) return;

        try {
          for (const { by, version: each } of history) {
            const answers = await Promise.all([
              outcome(async () => JSON.parse(JSON.stringify(await (by === "legacy" ? legacyDeployer : portDeployer)(onMixed).deploy(each, () => {})))),
              outcome(async () => JSON.parse(JSON.stringify(await portDeployer(onAlone).deploy(each, () => {}))))
            ].map(async (answer) => JSON.stringify(await answer).replaceAll(/ky-deploy-parity-\w+/g, "")));
            const order = (mixed.scripts.get("ky")?.migrations ?? []).map((migration) => ORDER.indexOf(migration.new_tag ?? ""));

            expect(answers[0], `${by} deploys ${each}`).toBe(answers[1]);
            expect(new Set(order).size, `migrations uploaded: ${order.join(", ")}`).toBe(order.length);
            expect(order).toEqual([...order].sort((a, b) => a - b));
            expect(snapshot(mixed)).toEqual(snapshot(alone));
          }
        } finally {
          await Promise.all(sides.map((side) => side.fake.close()));
        }
      }),
      { numRuns: budget().numRuns, seed: budget().seed }
    );
  }, 3_600_000);
});
