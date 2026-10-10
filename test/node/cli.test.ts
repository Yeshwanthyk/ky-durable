import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import { Cloudflare, SCOPES, tokenPage } from "../../cli/cloudflare.ts";
import { type Context, deployCommand, doctorCommand, teardownCommand, upgradeCommand } from "../../cli/commands.ts";
import { readOverlay, writeOverlay } from "../../cli/config.ts";
import { BYPASS } from "../../cli/deployer.ts";
import { initCommand } from "../../cli/init.ts";
import * as Cli from "../../cli/ky.ts";
import { loadRelease, packOf, type Release, releaseFiles, useRelease } from "../../cli/release.ts";
import { type FakeAccount, type FakeCloudflare, type FakeScript, fakeAccount, fakeCloudflare, WRANGLER_TOKEN } from "../fakes/cloudflare.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

const HOST = "ky.test.workers.dev";

const EMAIL = "owner@example.com";

const SETTINGS: Unstable_RawConfig = { account_id: "acc", name: "ky", vars: { ACCESS_EMAILS: EMAIL } };

const encode = (text: string) => new TextEncoder().encode(text);

/** A release of ky's real wrangler.jsonc, with a stand-in Worker and web app. */
function release(version: string, config = experimental_readRawConfig({ config: path.join(REPO, "wrangler.jsonc") }).rawConfig): Release {
  return {
    version,
    config: { ...config, main: "index.js" },
    modules: new Map([
      ["index.js", encode("export default {}")],
      ["assets/models.js", encode("export const models = []")]
    ]),
    assets: new Map([
      ["/index.html", encode("<!doctype html>")],
      ["/manifest.webmanifest", encode("{}")]
    ]),
    skill: "# ky"
  };
}

let fake: FakeCloudflare;

/** The fake's one account, "acc". */
let account: FakeAccount;

let output: string[];

/** The release `ky` carries; undefined before `pnpm compile`. */
let current: Release | undefined;

/** The run's Cloudflare login; undefined when signed out. */
let signedIn: Cloudflare | undefined;

const token = () => new Cloudflare("test-token", "CLOUDFLARE_API_TOKEN");

const wrangler = () => new Cloudflare(WRANGLER_TOKEN, "wrangler login");

function context(overlay: string): Context {
  return {
    overlay,
    release: async () => {
      if (!current) throw new Error("There's no release: run `pnpm compile` first");

      return current;
    },
    login: async () => {
      if (!signedIn) throw new Error("Not signed in to Cloudflare");

      return signedIn;
    },
    print: (line) => output.push(line),
    fail: (line) => output.push(line)
  };
}

async function fresh(): Promise<Context> {
  return context(path.join(await mkdtemp(path.join(tmpdir(), "ky-cli-")), "wrangler.local.jsonc"));
}

const script = (name = "ky") => account.scripts.get(name);

const apps = () => [...account.apps.values()];

/** A Worker deployed some other way, as `pnpm run deploy` deploys the owner's. */
function foreignWorker(bucket?: string): FakeScript {
  const bindings = bucket ? [{ type: "r2_bucket", name: "FILES", bucket_name: bucket }] : [];

  return { tags: [], migrations: [], metadata: { main_module: "index.js", bindings }, modules: ["index.js"], secrets: new Map(), workersDev: true };
}

async function setUp(): Promise<Context> {
  const ky = await fresh();

  await initCommand(ky, { account: "Test", name: "ky", email: EMAIL });

  return ky;
}

/** What `ky doctor` prints, and its exit code. */
async function doctor(ky: Context) {
  output = [];
  const code = await doctorCommand(ky, false);

  return { code, next: output.at(-1) };
}

/** What `ky doctor` says to fill in, filled in. */
const ANSWERS = new Map([
  ["<id or name>", "Test"],
  ["<worker>", "ky"],
  ["<you@example.com>", EMAIL],
  ["<name>", "test"]
]);

/** Runs `ky …` as the binary does, with its placeholders filled in, and expects it to succeed. */
async function run(ky: Context, command: string): Promise<void> {
  let filled = command;

  for (const [placeholder, answer] of ANSWERS) filled = filled.replaceAll(placeholder, answer);
  output = [];
  expect(await Cli.ky(filled.split(" ").slice(1), ky), `${filled}\n${output.join("\n")}`).toBe(0);
}

/**
 * Follows `ky doctor`'s Next until it says "All good", and returns each Next: a `ky …` one is run;
 * anything else is done by `outside`, the user at the dashboard, then the `ky …` it says to run.
 */
async function follow(ky: Context, outside: () => void | Promise<void> = () => {}): Promise<string[]> {
  const followed: string[] = [];

  for (let { next } = await doctor(ky); next !== "All good"; { next } = await doctor(ky)) {
    const step = next?.replace(/^Next: /, "") ?? "";

    followed.push(step);

    if (followed.length > 3) throw new Error(`ky doctor never passed: ${followed.join(" → ")}`);

    if (!step.startsWith("ky ")) await outside();
    const command = step.startsWith("ky ") ? step : /run `(ky [^`]+)`/.exec(step)?.[1];

    if (command && command !== "ky doctor") await run(ky, command);
  }

  return followed;
}

/** What the user does to the overlay when doctor says to pick another name. */
async function renameTo(ky: Context, name: string): Promise<void> {
  await writeOverlay(ky.overlay, { ...(await readOverlay(ky.overlay)), name });
}

beforeEach(async () => {
  account = fakeAccount("acc", "Test", { subdomain: "test", team: "test.cloudflareaccess.com" });
  fake = await fakeCloudflare(account);
  process.env.CLOUDFLARE_API_BASE_URL = fake.url;
  output = [];
  current = release("r1");
  signedIn = token();
});

afterEach(async () => {
  delete process.env.CLOUDFLARE_API_BASE_URL;
  await fake.close();
});

describe("ky init and deploy", () => {
  it("deploys the Worker with the release's config, every migration, ACCESS_* and a KY_TOKEN shown once", async () => {
    const ky = await setUp();
    const worker = script();
    const metadata = worker?.metadata;
    const bindings = metadata?.bindings ?? [];
    const text = (name: string) => bindings.find((binding) => binding.name === name)?.text;

    expect(await readOverlay(ky.overlay)).toEqual(SETTINGS);
    expect(worker).toMatchObject({ tags: ["ky", "ky-release-r1"], migrationTag: "v2", workersDev: true, modules: ["index.js", "assets/models.js"] });
    expect(worker?.migrations).toEqual([
      { new_tag: "v2", steps: [{ new_sqlite_classes: ["PiAgent"] }, { new_sqlite_classes: ["Vault"] }] }
    ]);
    expect(metadata).toMatchObject({
      compatibility_date: "2026-10-03",
      compatibility_flags: ["nodejs_compat"],
      observability: { enabled: true },
      assets: { jwt: "assets-complete", config: { not_found_handling: "single-page-application", run_worker_first: true } },
      keep_bindings: ["secret_text"]
    });
    expect(bindings).toEqual(
      expect.arrayContaining([
        { type: "version_metadata", name: "CF_VERSION_METADATA" },
        { type: "ai", name: "AI" },
        { type: "browser", name: "BROWSER" },
        { type: "assets", name: "ASSETS" },
        { type: "worker_loader", name: "LOADER" },
        { type: "r2_bucket", name: "FILES", bucket_name: "ky-files" },
        { type: "durable_object_namespace", name: "PiAgent", class_name: "PiAgent" },
        { type: "durable_object_namespace", name: "Vault", class_name: "Vault" },
        { type: "ratelimit", name: "PAIR_LIMIT", namespace_id: "1001", simple: { limit: 10, period: 60 } }
      ])
    );
    expect([text("ACCESS_TEAM_DOMAIN"), text("ACCESS_EMAILS")]).toEqual(["test.cloudflareaccess.com", EMAIL]);
    expect(text("ACCESS_AUD")).toBe(apps().find((app) => app.name === "ky")?.aud);
    expect(account.buckets).toEqual(new Map([["ky-files", new Set([".ky"])]]));
    const kyToken = worker?.secrets.get("KY_TOKEN");

    expect(kyToken).toMatch(/^[\w-]{32}$/);
    expect(output.filter((line) => line.includes(String(kyToken)))).toHaveLength(1);
    expect(output).toContain(`ky is live at https://${HOST}, behind Access for ${EMAIL}`);
  });

  it("sets up an Access app for the owner and a bypass app for the C2 paths", async () => {
    await setUp();

    expect(apps()).toEqual([
      expect.objectContaining({
        name: "ky",
        type: "self_hosted",
        tags: ["ky"],
        destinations: [{ type: "public", uri: HOST }],
        policies: [{ name: "owner", decision: "allow", include: [{ email: { email: EMAIL } }] }]
      }),
      expect.objectContaining({
        name: "ky bypass",
        type: "self_hosted",
        tags: ["ky"],
        destinations: BYPASS.map((bypass) => ({ type: "public", uri: `${HOST}${bypass}` })),
        policies: [{ name: "runners and files", decision: "bypass", include: [{ everyone: {} }] }]
      })
    ]);
    expect(account.tags).toEqual(new Set(["ky"]));
    expect(BYPASS).toEqual(["/runner/*", "/api/runners/pair", "/api/files", "/manifest.webmanifest", "/icons/*"]);
  });

  it("finds ky's Access apps by what they guard and their tag, not by name", async () => {
    const elsewhere = {
      id: "elsewhere",
      aud: "aud-elsewhere",
      name: "ky",
      type: "self_hosted",
      tags: ["ky"],
      destinations: [{ type: "public", uri: "ky.example.com" }],
      policies: [{ name: "team", decision: "allow", include: [] }]
    };

    const mine = { ...elsewhere, id: "mine", aud: "aud-mine", name: "my ky", destinations: [{ type: "public", uri: `HTTPS://KY.Test.workers.dev/` }] };

    account.tags.add("ky");
    account.apps.set("elsewhere", elsewhere).set("mine", mine);
    const ky = await setUp();

    expect(account.apps.get("elsewhere")).toEqual(elsewhere);
    expect(account.apps.get("mine")).toMatchObject({ aud: "aud-mine", destinations: [{ type: "public", uri: HOST }] });
    expect(apps()).toHaveLength(3);
    expect(script()?.metadata.bindings?.find((binding) => binding.name === "ACCESS_AUD")?.text).toBe("aud-mine");

    await teardownCommand(ky, "ky");
    expect([...account.apps.keys()]).toEqual(["elsewhere"]);
  });

  it("refuses an Access app on the address ky didn't make, and leaves it alone", async () => {
    const theirs = {
      id: "theirs",
      aud: "aud-theirs",
      name: "intranet",
      type: "self_hosted",
      destinations: [
        { type: "public", uri: HOST },
        { type: "public", uri: "intranet.example.com" }
      ],
      policies: [{ name: "staff", decision: "allow", include: [{ everyone: {} }] }]
    };

    account.apps.set("theirs", theirs);
    const ky = await fresh();

    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow(
      `An Access app named intranet already guards ${HOST} and ky didn't make it; pick another name: run \`ky init\` again with another --name`
    );
    expect(existsSync(ky.overlay)).toBe(false);
    expect(apps()).toEqual([theirs]);

    account.apps.clear();
    await initCommand(ky, { account: "acc", name: "ky", email: EMAIL });
    account.apps.set("theirs", theirs);
    expect(await doctor(ky)).toEqual({ code: 1, next: `Next: pick another name: set "name" in ${ky.overlay}, then run \`ky deploy\`` });
    expect(output).toContain(`✗ Access: An Access app named intranet already guards ${HOST} and ky didn't make it`);

    output = [];
    expect(await teardownCommand(ky, "ky")).toBe(0);
    expect(output).toContain("· Leaving the Access app intranet: ky didn't make it");
    expect(apps()).toEqual([theirs]);
  });

  it("upgrades without running migrations again, keeps the KY_TOKEN and the Access apps, and runs only a new migration", async () => {
    const ky = await setUp();
    const kyToken = script()?.secrets.get("KY_TOKEN");

    output = [];
    expect(await upgradeCommand(ky)).toBe(0);
    expect(output).toEqual(["Already on r1"]);

    current = release("r2");
    await upgradeCommand(ky);
    expect(script()).toMatchObject({ tags: ["ky", "ky-release-r2"], migrationTag: "v2" });
    expect(script()?.migrations).toHaveLength(1);
    expect(script()?.metadata.migrations).toBeUndefined();
    expect(script()?.secrets.get("KY_TOKEN")).toBe(kyToken);
    expect(output.some((line) => line.includes("KY_TOKEN"))).toBe(false);
    expect(output).toContain(`ky r2 is live at https://${HOST} (was r1)`);
    expect(apps()).toHaveLength(2);

    const config = release("r3").config;

    const v3 = { tag: "v3", deleted_classes: ["Vault"], transferred_classes: [{ from: "Room", from_script: "old-ky", to: "Room" }] };

    current = release("r3", { ...config, migrations: [...(config.migrations ?? []), v3] });
    await deployCommand(ky);
    expect(script()?.migrations.at(-1)).toEqual({
      old_tag: "v2",
      new_tag: "v3",
      steps: [{ deleted_classes: ["Vault"], transferred_classes: [{ from: "Room", from_script: "old-ky", to: "Room" }] }]
    });
    expect(script()?.migrationTag).toBe("v3");
    // Where wrangler reads it: the scripts list doesn't carry the migration tag.
    expect(fake.requests).toContain("GET workers/services/ky");
  });

  it("tells a ky older than the Worker to get a newer one, rather than to upgrade", async () => {
    const ky = await setUp();
    const config = release("r2").config;

    current = release("r2", { ...config, migrations: [...(config.migrations ?? []), { tag: "v3", deleted_classes: ["Vault"] }] });
    await upgradeCommand(ky);
    current = release("r1");
    const newer = "get a newer ky: `git pull && pnpm compile` in your ky checkout";

    expect(await doctor(ky)).toEqual({ code: 1, next: `Next: ${newer}` });
    expect(output).toContain("✗ Release: r2 ran migration v3: this ky (r1) is older than the Worker");
    await expect(upgradeCommand(ky)).rejects.toThrow(`The Worker ran migration v3, which this release doesn't have: this ky is older than the Worker; ${newer}`);
  });

  it("deploys a release's new bindings to an existing overlay", async () => {
    const ky = await setUp();
    const config = release("r2").config;

    current = release("r2", { ...config, r2_buckets: [...(config.r2_buckets ?? []), { binding: "RUNNER_FILES", bucket_name: "ky-runner-files" }] });
    await upgradeCommand(ky);
    expect(script()?.metadata.bindings).toContainEqual({ type: "r2_bucket", name: "RUNNER_FILES", bucket_name: "ky-runner-files" });
    expect([...account.buckets.keys()]).toEqual(["ky-files", "ky-runner-files"]);
  });

  it("refuses a name whose bucket R2 wouldn't take, before anything is written", async () => {
    const config = release("r1").config;
    const ky = await fresh();
    const name = "k".repeat(57);

    current = release("r1", { ...config, r2_buckets: [...(config.r2_buckets ?? []), { binding: "RUNNER_FILES", bucket_name: "ky-runner-files" }] });
    await expect(initCommand(ky, { account: "acc", name, email: EMAIL })).rejects.toThrow(
      `The RUNNER_FILES binding's bucket would be ${name}-runner-files, and R2 takes only 3 to 63 lowercase letters, digits and dashes: pick a shorter name`
    );
    expect(existsSync(ky.overlay)).toBe(false);
    expect(account.buckets.size).toBe(0);
  });

  it("uploads only the web app's files Cloudflare doesn't have", async () => {
    const ky = await setUp();
    const uploaded = new Set(account.assets);

    expect(uploaded.size).toBe(2);
    current = { ...release("r2"), assets: new Map([...release("r2").assets, ["/new.js", encode("new")]]) };
    await deployCommand(ky);
    expect(account.assets.size).toBe(3);
  });

  it("refuses a Worker or bucket of that name ky didn't make, and writes nothing", async () => {
    account.scripts.set("ky", foreignWorker("ky-files"));
    account.buckets.set("ky-files", new Set(["chat/a.png"]));
    const ky = await fresh();

    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow(
      "A Worker named ky is already in this account and ky didn't deploy it; pick another name: run `ky init` again with another --name"
    );
    account.scripts.set("live", foreignWorker("ky-files")).delete("ky");
    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow(
      "A bucket named ky-files is already in this account and ky didn't create it"
    );
    expect(existsSync(ky.overlay)).toBe(false);
    expect(account.apps.size).toBe(0);
    expect(account.buckets).toEqual(new Map([["ky-files", new Set(["chat/a.png"])]]));
  });

  it("asks for Zero Trust, a workers.dev subdomain, and a token that can manage Access", async () => {
    const ky = await fresh();

    account.team = undefined;
    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow(
      "Turn on Zero Trust at https://one.dash.cloudflare.com/acc"
    );
    account.team = "test.cloudflareaccess.com";
    signedIn = wrangler();
    const access = `(signed in with wrangler login). ky needs a token with ${SCOPES}: create one at ${tokenPage()} and set CLOUDFLARE_API_TOKEN to it.`;

    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow(access);
    expect(SCOPES).toContain("Access: Apps and Policies: Edit");
    signedIn = token();
    account.subdomain = undefined;
    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow("Pass --subdomain <name>");
    await initCommand(ky, { account: "acc", name: "ky", email: EMAIL, subdomain: "test" });
    expect(account.subdomain).toBe("test");
    expect(script()).toBeDefined();

    signedIn = wrangler();
    await expect(deployCommand(ky)).rejects.toThrow(access);
  });

  it("fills in what the overlay lacks, and keeps what it has", async () => {
    const ky = await fresh();

    await writeOverlay(ky.overlay, { account_id: "acc", name: "ky" });
    await expect(deployCommand(ky)).rejects.toThrow(`${ky.overlay} has no ACCESS_EMAILS; run \`ky init --email <you@example.com>\``);
    await initCommand(ky, { email: EMAIL });
    expect(await readOverlay(ky.overlay)).toEqual(SETTINGS);
    expect(script()).toBeDefined();
    await expect(initCommand(ky, { name: "other" })).rejects.toThrow(`${ky.overlay} already sets name to ky; edit it there to change it`);
  });

  it("keeps the settings when the deploy fails, and says to retry with ky deploy", async () => {
    const ky = await fresh();
    const r1 = release("r1");

    current = { ...r1, config: { ...r1.config, main: "missing.js" } };
    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow(
      `Your settings are saved in ${ky.overlay}: run \`ky deploy\` to retry`
    );
    expect(await readOverlay(ky.overlay)).toEqual(SETTINGS);
    current = r1;
    await run(ky, "ky deploy");
    expect(script()).toBeDefined();
  });
});

describe("ky doctor", () => {
  it("prints each check", async () => {
    const ky = await setUp();

    expect(await doctor(ky)).toEqual({ code: 0, next: "All good" });
    expect(output.slice(0, -1)).toEqual([
      `✓ Config: ${ky.overlay}`,
      "✓ Cloudflare login: CLOUDFLARE_API_TOKEN",
      "✓ Zero Trust: test.cloudflareaccess.com",
      "✓ workers.dev subdomain: test",
      "✓ Bucket: ky-files",
      "✓ Worker: ky",
      "✓ Release: r1",
      "✓ Migrations: v2",
      "✓ KY_TOKEN: set",
      `✓ Access for the owner: ${HOST}`,
      "✓ Access bypass: 5 paths",
      `✓ workers.dev: https://${HOST}`
    ]);

    account.team = undefined;
    await doctorCommand(ky, true);
    expect(JSON.parse(output.at(-1) ?? "")).toMatchObject({
      checks: expect.arrayContaining([{ name: "Zero Trust", ok: false, detail: "off", next: expect.stringContaining("one.dash.cloudflare.com/acc") }]),
      next: expect.stringContaining("turn it on")
    });
  });

  it("reports a login Access refuses, and a Worker ky didn't deploy, as checks", async () => {
    const ky = await setUp();

    signedIn = wrangler();
    expect(await doctor(ky)).toEqual({ code: 1, next: `Next: set CLOUDFLARE_API_TOKEN to a token from ${tokenPage()}, then run \`ky doctor\`` });
    expect(output).toContain(`✗ Cloudflare permissions: Cloudflare refused wrangler login; ky needs ${SCOPES}`);

    signedIn = token();
    script()?.tags.splice(0);
    expect(await doctor(ky)).toEqual({ code: 1, next: `Next: pick another name: set "name" in ${ky.overlay}, then run \`ky deploy\`` });
    expect(output).toContain("✗ Worker: ky is a Worker ky didn't deploy");
  });

  /** Each way a deploy can be broken: what breaks it (after `ky init`, unless `given`), what the user does outside ky, and the Nexts that fix it. */
  const BROKEN: {
    state: string;
    given?: () => Promise<Context>;
    breaks?: (worker: FakeScript, ky: Context) => void | Promise<void>;
    outside?: (ky: Context) => void | Promise<void>;
    nexts: unknown[];
  }[] = [
    { state: "no settings", given: fresh, nexts: ["ky init --account <id or name> --name <worker> --email <you@example.com>"] },
    {
      state: "a setting missing",
      given: async () => {
        const ky = await fresh();

        await writeOverlay(ky.overlay, { account_id: "acc", name: "ky" });

        return ky;
      },
      nexts: ["ky init --email <you@example.com>"]
    },
    {
      state: "a setting ky's overlay refuses",
      breaks: (_, ky) => writeOverlay(ky.overlay, { ...SETTINGS, r2_buckets: [{ binding: "FILES", bucket_name: "ky-files" }] }),
      outside: (ky) => writeOverlay(ky.overlay, SETTINGS),
      nexts: [expect.stringMatching(/^fix .*wrangler\.local\.jsonc, then run `ky doctor`$/)]
    },
    {
      state: "no compiled release",
      breaks: () => {
        current = undefined;
      },
      outside: () => {
        current = release("r1");
      },
      nexts: ["pnpm compile"]
    },
    {
      state: "no login",
      breaks: () => {
        signedIn = undefined;
      },
      outside: () => {
        signedIn = token();
      },
      nexts: [`wrangler login, or set CLOUDFLARE_API_TOKEN to a token from ${tokenPage()}`]
    },
    {
      state: "a wrangler login, which Access refuses",
      breaks: () => {
        signedIn = wrangler();
      },
      outside: () => {
        signedIn = token();
      },
      nexts: [`set CLOUDFLARE_API_TOKEN to a token from ${tokenPage()}, then run \`ky doctor\``]
    },
    {
      state: "Zero Trust off",
      breaks: () => {
        account.team = undefined;
      },
      outside: () => {
        account.team = "test.cloudflareaccess.com";
      },
      nexts: ["turn it on at https://one.dash.cloudflare.com/acc (the free plan is enough), then run `ky deploy`"]
    },
    {
      state: "no workers.dev subdomain",
      breaks: () => {
        account.subdomain = undefined;
      },
      nexts: ["ky init --subdomain <name>"]
    },
    {
      state: "a Worker ky didn't deploy",
      breaks: (worker) => {
        worker.tags.splice(0);
      },
      outside: (ky) => renameTo(ky, "ky2"),
      nexts: [expect.stringMatching(/^pick another name: set "name" in .*, then run `ky deploy`$/)]
    },
    {
      state: "a bucket ky didn't create",
      given: async () => {
        const ky = await fresh();

        await writeOverlay(ky.overlay, SETTINGS);
        account.buckets.set("ky-files", new Set(["chat/a.png"]));

        return ky;
      },
      outside: (ky) => renameTo(ky, "ky2"),
      nexts: [expect.stringMatching(/^pick another name: set "name" in .*, then run `ky deploy`$/)]
    },
    {
      state: "no Worker",
      breaks: () => {
        account.scripts.delete("ky");
      },
      nexts: ["ky deploy"]
    },
    {
      state: "an older release",
      breaks: () => {
        current = release("r2");
      },
      nexts: ["ky upgrade"]
    },
    {
      state: "a migration behind",
      breaks: (worker) => {
        worker.migrationTag = "v1";
      },
      nexts: ["ky deploy"]
    },
    {
      state: "no KY_TOKEN",
      breaks: (worker) => {
        worker.secrets.delete("KY_TOKEN");
      },
      nexts: ["ky deploy"]
    },
    {
      state: "no bypass app",
      breaks: () => {
        account.apps.delete(apps().find((app) => app.name === "ky bypass")?.id ?? "");
      },
      nexts: ["ky deploy"]
    },
    {
      state: "workers.dev off",
      breaks: (worker) => {
        worker.workersDev = false;
      },
      nexts: ["ky deploy"]
    }
  ];

  it.each(BROKEN)("with $state, each Next leads to a deploy that passes", async ({ given, breaks, outside, nexts }) => {
    const ky = given ? await given() : await setUp();
    const worker = script();

    if (breaks && worker) await breaks(worker, ky);
    expect(await follow(ky, () => outside?.(ky))).toEqual(nexts);
  });
});

describe("ky teardown", () => {
  it("removes the Worker with its data and secrets, then its Access apps and the emptied bucket, then the overlay", async () => {
    const ky = await setUp();

    account.buckets.get("ky-files")?.add("chat/a.png").add("chat/b.png");
    await expect(teardownCommand(ky, undefined)).rejects.toThrow("ky teardown --confirm ky");
    await expect(teardownCommand(ky, "other")).rejects.toThrow("ky teardown --confirm ky");
    expect(script()).toBeDefined();

    fake.requests.splice(0);
    expect(await teardownCommand(ky, "ky")).toBe(0);
    expect(account.scripts.size).toBe(0);
    expect(account.buckets.size).toBe(0);
    expect(account.apps.size).toBe(0);
    expect(existsSync(ky.overlay)).toBe(false);
    expect(output.at(-1)).toBe("Removed ky");
    const removals = fake.requests.filter((request) => request.startsWith("DELETE"));

    expect(removals.map((request) => request.split("/").slice(0, 2).join("/"))).toEqual([
      "DELETE workers/scripts",
      "DELETE access/apps",
      "DELETE access/apps",
      "DELETE r2/buckets",
      "DELETE r2/buckets"
    ]);
  });

  it("leaves a Worker of that name ky didn't deploy alone", async () => {
    const ky = await setUp();

    script()?.tags.splice(0);
    await expect(teardownCommand(ky, "ky")).rejects.toThrow("ky didn't deploy it, so ky teardown leaves it alone");
    expect(script()).toBeDefined();
    expect(account.apps.size).toBe(2);
    expect(account.buckets.size).toBe(1);
  });

  it("says it can't find the Access apps once the workers.dev subdomain is gone, and keeps the overlay", async () => {
    const ky = await setUp();

    account.subdomain = undefined;
    await expect(teardownCommand(ky, "ky")).rejects.toThrow(
      `This account has no workers.dev subdomain, so ky can't find the Access apps that guarded ky: remove them at https://one.dash.cloudflare.com/acc, then delete ${ky.overlay}`
    );
    expect(account.scripts.size).toBe(0);
    expect(account.buckets.size).toBe(0);
    expect(account.apps.size).toBe(2);
    expect(existsSync(ky.overlay)).toBe(true);
  });

  it("leaves a bucket another Worker binds, and the production ky Worker's bucket", async () => {
    account.scripts.set("ky", foreignWorker("ky-files"));
    account.buckets.set("ky-files", new Set(["chat/a.png"]));
    const ky = await fresh();

    await initCommand(ky, { account: "acc", name: "ky2", email: EMAIL });
    account.scripts.set("other", { ...foreignWorker("ky2-files"), tags: ["ky"] });
    expect(await teardownCommand(ky, "ky2")).toBe(0);
    expect(output).toContain("· Leaving the bucket ky2-files: other binds it");
    expect([...account.scripts.keys()]).toEqual(["ky", "other"]);
    expect(account.buckets).toEqual(
      new Map([
        ["ky-files", new Set(["chat/a.png"])],
        ["ky2-files", new Set([".ky"])]
      ])
    );
  });
});

describe("the ky command", () => {
  it("prints a bad flag's message rather than a stack, and help", async () => {
    const ky = await setUp();

    output = [];
    expect(await Cli.ky(["deploy", "--bogus"], ky)).toBe(1);
    expect(output).toEqual([expect.stringMatching(/^ky: Unknown option '--bogus'/)]);
    expect(output[0]).not.toContain("    at ");
    output = [];
    expect(await Cli.ky(["--help"], ky)).toBe(0);
    expect(output[0]).toContain("ky init");
    expect(await Cli.ky(["nope"], ky)).toBe(2);
  });
});

describe("the release pack", () => {
  it("carries the release the compiled ky deploys", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ky-release-"));
    const r1 = release("r1");

    for (const [name, content] of [
      ["release.json", encode(JSON.stringify({ version: r1.version, config: r1.config }))],
      ["SKILL.md", encode(r1.skill)],
      ...[...r1.modules].map(([module, content]) => [`worker/${module}`, content] as const),
      ...[...r1.assets].map(([asset, content]) => [`assets${asset}`, content] as const)
    ] as const) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }

    const pack = path.join(dir, "release.pack");

    await writeFile(pack, packOf(await releaseFiles(dir)));
    useRelease(pack);
    const loaded = await loadRelease();

    expect(loaded).toEqual({ ...r1, modules: new Map([...r1.modules].map(([name, content]) => [name, Buffer.from(content)])), assets: expect.any(Map) });
    expect([...loaded.assets.keys()].sort()).toEqual(["/index.html", "/manifest.webmanifest"]);
  });
});
