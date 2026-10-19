import { existsSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import { Cloudflare, lacks, SCOPES, tokenPage } from "../../cli/cloudflare.ts";
import { type Context, deployCommand, doctorCommand, teardownCommand, upgradeCommand } from "../../cli/commands.ts";
import { deployedPath, readOverlay, writeOverlay } from "../../cli/config.ts";
import { BYPASS } from "../../src/access.ts";
import { initCommand } from "../../cli/init.ts";
import { savedToken } from "../../cli/login.ts";
import * as Cli from "../../cli/ky.ts";
import { banner, bold } from "../../cli/output.ts";
import { settingsFile, writeSettings } from "../../cli/runner/settings.ts";
import { bundleOf, loadRelease, packOf, type Release, useRelease } from "../../cli/release.ts";
import { type FakeSystem, fakeSystem } from "../fakes/system.ts";
import { type FakeRegistry, fakeRegistry } from "../fakes/registry.ts";
import { type FakeAccount, type FakeCloudflare, type FakeScript, fakeAccount, fakeCloudflare, fakeZone, NO_ORGANIZATION_TOKEN, WRANGLER_TOKEN } from "../fakes/cloudflare.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

const HOST = "ky.test.workers.dev";

const EMAIL = "owner@example.com";

const SETTINGS: Unstable_RawConfig = { account_id: "acc", name: "ky", vars: { ACCESS_EMAILS: EMAIL } };

const encode = (text: string) => new TextEncoder().encode(text);

/** A release of ky's real wrangler.jsonc, with a stand-in Worker and web app. */
function release(version: string, config = experimental_readRawConfig({ config: path.join(REPO, "wrangler.jsonc") }).rawConfig): Release {
  return {
    version,
    bundle: `sha256:${version}`,
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

/** The run's CLOUDFLARE_API_TOKEN or wrangler login; undefined when neither. */
let signedIn: Cloudflare | undefined;

/** What the user pipes into `ky login`: a token from the page tokenPage() opens. */
let pasted: string | undefined;

const token = () => new Cloudflare("test-token", "CLOUDFLARE_API_TOKEN");

const wrangler = () => new Cloudflare(WRANGLER_TOKEN, "wrangler login");

/** Why a wrangler login can't deploy: Access refuses it. */
const WRANGLER_LACKS = lacks("wrangler login", ["Access: Apps and Policies: Edit", "Access: Organizations, Identity Providers, and Groups: Read"]);

/** A run of `ky` on a fake computer, which the test can look into. */
type Run = Context & { system: FakeSystem };

function context(overlay: string, system: FakeSystem): Run {
  return {
    system,
    env: {},
    sleep: async () => {},
    overlay,
    release: async () => {
      if (!current) throw new Error("There's no release: run `pnpm compile` first");

      return current;
    },
    // As cli/cloudflare.ts's login: CLOUDFLARE_API_TOKEN, else the token `ky login` kept, else wrangler's.
    login: async () => {
      const kept = await savedToken(system);

      if (signedIn?.login !== "CLOUDFLARE_API_TOKEN" && kept) return new Cloudflare(kept, "ky login");

      if (!signedIn) throw new Error("Not signed in to Cloudflare: run `ky login`");

      return signedIn;
    },
    print: (line) => output.push(line),
    fail: (line) => output.push(line),
    stdin: async () => pasted
  };
}

async function fresh(): Promise<Run> {
  return context(path.join(await mkdtemp(path.join(tmpdir(), "ky-cli-")), "wrangler.local.jsonc"), await fakeSystem());
}

const script = (name = "ky") => account.scripts.get(name);

const apps = () => [...account.apps.values()];

/** A Worker deployed some other way, as a `wrangler deploy` from a checkout would. */
function foreignWorker(bucket?: string): FakeScript {
  const bindings = bucket ? [{ type: "r2_bucket", name: "FILES", bucket_name: bucket }] : [];

  return { tags: [], migrations: [], metadata: { main_module: "index.js", bindings }, modules: ["index.js"], secrets: new Map(), workersDev: true };
}

async function setUp(): Promise<Run> {
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

/** The checks `ky doctor` printed, each as `<mark> <name>: <detail>`: without the padding that lines them up, or a failure's `→ next`. */
function checks(): string[] {
  return output.slice(0, -1).map((line) => line.replace(/^(.) (.+?) {2,}(.*?)( {2}→ .*)?$/, "$1 $2: $3"));
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
  pasted = "token-from-the-tokens-page";
});

afterEach(async () => {
  delete process.env.CLOUDFLARE_API_BASE_URL;
  await fake.close();
});

describe("ky init and deploy", () => {
  it("deploys the Worker with the release's config, every migration and ACCESS_*", async () => {
    const ky = await setUp();
    const worker = script();
    const metadata = worker?.metadata;
    const bindings = metadata?.bindings ?? [];
    const text = (name: string) => bindings.find((binding) => binding.name === name)?.text;

    expect(await readOverlay(ky.overlay)).toEqual(SETTINGS);
    expect(worker).toMatchObject({ tags: ["ky", "ky-release-r1"], migrationTag: "v3", workersDev: true, modules: ["index.js", "assets/models.js"] });
    expect(worker?.migrations).toEqual([
      { new_tag: "v3", steps: [{ new_sqlite_classes: ["PiAgent"] }, { new_sqlite_classes: ["Vault"] }, { new_sqlite_classes: ["CloudMachine"] }] }
    ]);
    expect(metadata).toMatchObject({
      compatibility_date: "2026-10-03",
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
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
    expect(worker?.secrets.size).toBe(0);
    expect(output).toContain(`ky is live at https://${HOST}, behind Access for ${EMAIL}`);
  });

  it("saves where it went live beside the overlay, for ky backup and ky restore, with no token in it", async () => {
    const ky = await setUp();
    const saved = await readFile(deployedPath(ky.overlay), "utf8");

    expect(JSON.parse(saved)).toEqual({ account: "acc", name: "ky", url: `https://${HOST}` });
    expect(saved).not.toContain("test-token");

    await writeFile(deployedPath(ky.overlay), "{}");
    await deployCommand(ky);
    expect(JSON.parse(await readFile(deployedPath(ky.overlay), "utf8"))).toEqual({ account: "acc", name: "ky", url: `https://${HOST}` });
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
    expect(BYPASS).toEqual(["/runner/*", "/api/runners/pair", "/api/files", "/peer/*", "/manifest.webmanifest", "/icons/*"]);
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
    expect(checks()).toContain(`✗ Access: An Access app named intranet already guards ${HOST} and ky didn't make it`);

    output = [];
    expect(await teardownCommand(ky, "ky")).toBe(0);
    expect(output).toContain("· Leaving the Access app intranet: ky didn't make it");
    expect(apps()).toEqual([theirs]);
  });

  it("upgrades without running migrations again, keeps the Access apps, and runs only a new migration", async () => {
    const ky = await setUp();
    output = [];
    expect(await upgradeCommand(ky)).toBe(0);
    expect(output).toEqual(["Already on r1"]);

    current = release("r2");
    await upgradeCommand(ky);
    expect(script()).toMatchObject({ tags: ["ky", "ky-release-r2"], migrationTag: "v3" });
    expect(script()?.migrations).toHaveLength(1);
    expect(script()?.metadata.migrations).toBeUndefined();
    expect(output).toContain(`ky r2 is live at https://${HOST} (was r1)`);
    expect(apps()).toHaveLength(2);

    const config = release("r3").config;

    const v4 = { tag: "v4", deleted_classes: ["Vault"], transferred_classes: [{ from: "Room", from_script: "old-ky", to: "Room" }] };

    current = release("r3", { ...config, migrations: [...(config.migrations ?? []), v4] });
    await deployCommand(ky);
    expect(script()?.migrations.at(-1)).toEqual({
      old_tag: "v3",
      new_tag: "v4",
      steps: [{ deleted_classes: ["Vault"], transferred_classes: [{ from: "Room", from_script: "old-ky", to: "Room" }] }]
    });
    expect(script()?.migrationTag).toBe("v4");
    // Where wrangler reads it: the scripts list doesn't carry the migration tag.
    expect(fake.requests).toContain("GET workers/services/ky");
  });

  it("tells a ky older than the Worker to get a newer one, rather than to upgrade", async () => {
    const ky = await setUp();
    const config = release("r2").config;

    current = release("r2", { ...config, migrations: [...(config.migrations ?? []), { tag: "v4", deleted_classes: ["Vault"] }] });
    await upgradeCommand(ky);
    current = release("r1");
    const newer = "get a newer ky: `git pull && pnpm compile` in your ky checkout";

    expect(await doctor(ky)).toEqual({ code: 1, next: `Next: ${newer}` });
    expect(checks()).toContain("✗ Release: r2 ran migration v4: this ky (r1) is older than the Worker");
    await expect(upgradeCommand(ky)).rejects.toThrow(`The Worker ran migration v4, which this release doesn't have: this ky is older than the Worker; ${newer}`);
  });

  it("deploys a release's new bindings to an existing overlay", async () => {
    const ky = await setUp();
    const config = release("r2").config;

    current = release("r2", { ...config, r2_buckets: [...(config.r2_buckets ?? []), { binding: "RUNNER_FILES", bucket_name: "ky-runner-files" }] });
    await upgradeCommand(ky);
    expect(script()?.metadata.bindings).toContainEqual({ type: "r2_bucket", name: "RUNNER_FILES", bucket_name: "ky-runner-files" });
    expect([...account.buckets.keys()]).toEqual(["ky-files", "ky-runner-files"]);
  });

  it("gives ky <name>@<domain> with --mail, routes it to the Worker once, and sends from that address only", async () => {
    const zone = fakeZone("example.com");

    account.zones.set(zone.id, zone);
    const ky = await fresh();

    await initCommand(ky, { account: "Test", name: "ky", email: EMAIL, mail: "Example.com" });
    expect(await readOverlay(ky.overlay)).toMatchObject({
      vars: { KY_MAIL_ADDRESS: "ky@example.com" },
      send_email: [{ name: "EMAIL", allowed_sender_addresses: ["ky@example.com"] }]
    });
    expect(script()?.metadata.bindings).toEqual(
      expect.arrayContaining([
        { type: "send_email", name: "EMAIL", allowed_sender_addresses: ["ky@example.com"] },
        { type: "plain_text", name: "KY_MAIL_ADDRESS", text: "ky@example.com" }
      ])
    );
    await deployCommand(ky);
    expect(zone.rules).toEqual([
      { id: "rule-1", name: "ky: ky", enabled: true, matchers: [{ type: "literal", field: "to", value: "ky@example.com" }], actions: [{ type: "worker", value: ["ky"] }] }
    ]);
    await expect(initCommand(ky, { mail: "example.com" })).rejects.toThrow("This ky's address is already ky@example.com");
  });

  it("gives each ky on one domain its own address, routed to its own Worker", async () => {
    const zone = fakeZone("example.com");

    account.zones.set(zone.id, zone);
    await initCommand(await fresh(), { account: "Test", name: "ky", email: EMAIL, mail: "example.com" });
    await initCommand(await fresh(), { account: "Test", name: "work", email: EMAIL, mail: "example.com" });
    expect(zone.rules.map((rule) => [rule.matchers[0]?.value, rule.actions[0]?.value])).toEqual([
      ["ky@example.com", ["ky"]],
      ["work@example.com", ["work"]]
    ]);
  });

  it("says what stops ky's mail: a domain not on the account, Email Routing off, or the address routed elsewhere", async () => {
    const ky = await fresh();

    await expect(initCommand(ky, { account: "Test", name: "ky", email: EMAIL, mail: "example.com" })).rejects.toThrow(
      "example.com, ky's mail domain, isn't on this Cloudflare account"
    );
    const zone = fakeZone("example.com", { routing: false });

    account.zones.set(zone.id, zone);
    await expect(deployCommand(ky)).rejects.toThrow("Email Routing is off for example.com: turn it on at https://dash.cloudflare.com/acc/example.com/email/routing/overview");
    zone.routing = true;
    zone.rules.push({ id: "theirs", name: "", enabled: true, matchers: [{ type: "literal", field: "to", value: "ky@example.com" }], actions: [{ type: "forward", value: ["me@else.test"] }] });
    await expect(deployCommand(ky)).rejects.toThrow("An Email Routing rule already sends ky@example.com elsewhere");
    expect(zone.rules).toHaveLength(1);
  });

  it("refuses a --mail that isn't a domain", async () => {
    await expect(initCommand(await fresh(), { account: "Test", name: "ky", email: EMAIL, mail: "not a domain" })).rejects.toThrow("--mail not a domain: a domain");
  });

  it("refuses an overlay that would replace the release's own bindings", async () => {
    const ky = await setUp();

    await writeOverlay(ky.overlay, { ...(await readOverlay(ky.overlay)), r2_buckets: [] });
    await expect(deployCommand(ky)).rejects.toThrow("sets `r2_buckets`, which would replace ky's own");
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
    const access = `(signed in with wrangler login). ky needs a token with ${SCOPES}: create one at ${tokenPage()}, then run \`ky login\`.`;

    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow(access);
    expect(SCOPES).toContain("Access: Apps and Policies: Edit");
    signedIn = token();
    account.subdomain = undefined;
    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow("Pass --subdomain <name>");
    await initCommand(ky, { account: "acc", name: "ky", email: EMAIL, subdomain: "test" });
    expect(account.subdomain).toBe("test");
    expect(script()).toBeDefined();

    signedIn = wrangler();
    await expect(deployCommand(ky)).rejects.toThrow(WRANGLER_LACKS);
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
    expect(output[1]).toBe("✓ Cloudflare login       CLOUDFLARE_API_TOKEN");
    expect(checks()).toEqual([
      `✓ Config: ${ky.overlay}`,
      "✓ Cloudflare login: CLOUDFLARE_API_TOKEN",
      "✓ Zero Trust: test.cloudflareaccess.com",
      "✓ workers.dev subdomain: test",
      "✓ Bucket: ky-files",
      "✓ Worker: ky",
      "✓ Release: r1",
      "✓ Migrations: v3",
      `✓ Access for the owner: ${HOST}`,
      "✓ Access bypass: 6 paths",
      `✓ workers.dev: https://${HOST}`,
      "✓ Cloud machine: off, so tasks run on your computers: this ky's release has no cloud machine image"
    ]);

    // Deployed from a checkout, labelled with its commit: the release built from that commit runs it, another doesn't.
    const commit = "a65f3c6d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7";

    current = release("a65f3c6");
    await deployCommand(ky);
    current = { ...release("0.2.10"), commit };
    expect(await doctor(ky)).toEqual({ code: 0, next: "All good" });
    expect(checks()).toContain("✓ Release: 0.2.10, built from a65f3c6");
    output = [];
    expect(await upgradeCommand(ky)).toBe(0);
    expect(output).toEqual(["Already on 0.2.10"]);
    current = { ...release("0.2.11"), commit: "b".repeat(40) };
    expect(await doctor(ky)).toEqual({ code: 1, next: "Next: ky upgrade" });
    expect(checks()).toContain("✗ Release: a65f3c6, this ky is 0.2.11");
    current = release("r1");
    await deployCommand(ky);

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
    expect(await doctor(ky)).toEqual({ code: 1, next: "Next: ky login" });
    expect(checks()).toContain(`✗ Cloudflare login: ${WRANGLER_LACKS}`);

    signedIn = token();
    script()?.tags.splice(0);
    expect(await doctor(ky)).toEqual({ code: 1, next: `Next: pick another name: set "name" in ${ky.overlay}, then run \`ky deploy\`` });
    expect(checks()).toContain("✗ Worker: ky is a Worker ky didn't deploy");
    expect(output).toContainEqual(expect.stringMatching(/^✗ Worker +ky is a Worker ky didn't deploy {2}→ pick another name: set "name" in /));
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
      nexts: ["ky login"]
    },
    {
      state: "a wrangler login, which Access refuses",
      breaks: () => {
        signedIn = wrangler();
      },
      nexts: ["ky login"]
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

describe("the cloud machine", () => {
  let registry: FakeRegistry;

  const container = () => [...account.containerApps.values()][0];

  const binding = (name: string) => script()?.metadata.bindings?.find((each) => each.name === name);

  beforeEach(async () => {
    registry = await fakeRegistry();
    process.env.KY_REGISTRY_BASE_URL = registry.url;
    current = { ...release("r1"), image: registry.source };
  });

  afterEach(async () => {
    delete process.env.KY_REGISTRY_BASE_URL;
    await registry.close();
  });

  it("is skipped on an account without Workers Paid, and doctor says tasks run on your computers", async () => {
    const ky = await setUp();

    expect(output).toContain("· Skipping the cloud machine: this account can't run containers: it needs Workers Paid (https://dash.cloudflare.com/acc/workers/plans), and a login with Containers: Edit");
    expect(script()?.metadata.containers).toBeUndefined();
    expect(binding("KY_CLOUD")).toBeUndefined();
    expect(registry.uploads()).toBe(0);
    expect(await doctor(ky)).toEqual({ code: 0, next: "All good" });
    expect(checks()).toContain("✓ Cloud machine: off, so tasks run on your computers: this account can't run containers: it needs Workers Paid (https://dash.cloudflare.com/acc/workers/plans), and a login with Containers: Edit");
  });

  it("copies the image, attaches it to the CloudMachine namespace, rolls out a new one, and goes first on teardown", async () => {
    account.paid = true;
    const ky = await setUp();
    const image = `registry.cloudflare.com/acc/ky-cloud@${registry.manifest}`;

    expect(registry.pushed.get("acc/ky-cloud")?.size).toBe(3);
    expect(script()?.metadata.containers).toEqual([{ class_name: "CloudMachine" }]);
    expect(binding("KY_CLOUD")).toMatchObject({ type: "plain_text", text: "1" });
    expect(container()).toMatchObject({
      name: "ky-cloud",
      max_instances: 9,
      instances: 0,
      configuration: { image, instance_type: "standard-1" },
      durable_objects: { namespace_id: "ns-ky-CloudMachine" }
    });
    expect(await doctor(ky)).toEqual({ code: 0, next: "All good" });
    expect(checks()).toContain("✓ Cloud machine: ky-cloud");

    // The same image again: nothing copied, nothing rolled out.
    fake.requests.splice(0);
    await deployCommand(ky);
    expect(registry.uploads()).toBe(3);
    expect(fake.requests.filter((request) => request.startsWith("PATCH") || request.includes("rollouts"))).toEqual([]);
    expect(account.containerApps.size).toBe(1);

    // Pinned to the linux/amd64 manifest the account's registry already holds, as the image
    // workflow pins it: GitHub's registry isn't asked at all.
    const pulls = registry.pulls();

    current = { ...release("r1"), image: `ghcr.io/ky-owner/ky-cloud@${registry.manifest}` };
    await deployCommand(ky);
    expect(registry.pulls()).toBe(pulls);
    expect(registry.uploads()).toBe(3);
    expect(container()?.configuration.image).toBe(image);

    // The account's list still naming the image a rollout replaced: doctor and deploy read the app itself.
    const rolled = container();

    if (!rolled) throw new Error("No container app");
    rolled.listed = { ...rolled.configuration, image: `registry.cloudflare.com/acc/ky-cloud@sha256:${"1".repeat(64)}` };
    expect(await doctor(ky)).toEqual({ code: 0, next: "All good" });
    fake.requests.splice(0);
    await deployCommand(ky);
    expect(fake.requests.filter((request) => request.includes("rollouts"))).toEqual([]);
    rolled.listed = undefined;

    // An app on another image: doctor says so, and a deploy rolls this one out.
    const app = container();

    if (!app) throw new Error("No container app");
    app.configuration.image = `registry.cloudflare.com/acc/ky-cloud@sha256:${"0".repeat(64)}`;
    expect(await doctor(ky)).toEqual({ code: 1, next: "Next: ky deploy" });
    await deployCommand(ky);
    expect(output).toContain("· Rolling out the cloud machine's new image");
    expect(app.configuration.image).toBe(image);
    expect(app.rollouts).toEqual([{ image, instance_type: "standard-1" }]);

    // An app from before sandboxes, with room for one: a deploy raises it, and rolls nothing out.
    app.max_instances = 1;
    fake.requests.splice(0);
    await deployCommand(ky);
    expect(output).toContain("· Making room for the sandboxes");
    expect(app.max_instances).toBe(9);
    expect(app.rollouts).toHaveLength(1);
    expect(fake.requests.filter((request) => request.includes("rollouts"))).toEqual([]);

    // A higher limit the user set: a deploy leaves it.
    app.max_instances = 20;
    fake.requests.splice(0);
    await deployCommand(ky);
    expect(app.max_instances).toBe(20);
    expect(fake.requests.filter((request) => request.startsWith("PATCH"))).toEqual([]);

    account.containerApps.clear();
    expect(await doctor(ky)).toEqual({ code: 1, next: "Next: ky deploy" });
    expect(checks()).toContain("✗ Cloud machine: no container app");
    await deployCommand(ky);
    expect(account.containerApps.size).toBe(1);

    fake.requests.splice(0);
    expect(await teardownCommand(ky, "ky")).toBe(0);
    expect(account.containerApps.size).toBe(0);
    expect(fake.requests.filter((request) => request.startsWith("DELETE")).slice(0, 2).map((request) => request.split("/").slice(0, 2).join("/"))).toEqual([
      "DELETE containers/applications",
      "DELETE workers/scripts"
    ]);
  });

  it("pulls a private image with KY_GHCR_TOKEN, and says what to do without it", async () => {
    account.paid = true;
    registry.privately("gh-read-packages");

    await expect(setUp()).rejects.toThrow(/\(403\): make the ky-cloud package public on GitHub, or set KY_GHCR_TOKEN/);
    expect(registry.uploads()).toBe(0);

    process.env.KY_GHCR_TOKEN = "gh-read-packages";

    try {
      await setUp();
    } finally {
      delete process.env.KY_GHCR_TOKEN;
    }

    expect(registry.pushed.get("acc/ky-cloud")?.size).toBe(3);
    expect(container()?.configuration.image).toBe(`registry.cloudflare.com/acc/ky-cloud@${registry.manifest}`);
  });

  it("reads a published release's image from the release.json beside it, and only that release's", async () => {
    account.paid = true;
    let published = { ...release("r1"), image: registry.source };

    const server = createServer((request, response) =>
      request.url === "/v1/release.json" ? response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(published)) : response.writeHead(404).end()
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port has an AddressInfo address.
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      current = { ...release("r1"), imageFrom: `${base}/v1/release.json` };
      const ky = await setUp();

      expect(container()?.configuration.image).toBe(`registry.cloudflare.com/acc/ky-cloud@${registry.manifest}`);

      // Another release's file: refused, and the cloud machine is left as it is.
      published = { ...release("r0"), image: registry.source };
      await expect(deployCommand(ky)).rejects.toThrow(`${base}/v1/release.json is another release's (r0, sha256:r0), not ky r1's`);

      current = { ...release("r1"), imageFrom: `${base}/v2/release.json` };
      await expect(deployCommand(ky)).rejects.toThrow(`Couldn't read the cloud machine's image from ${base}/v2/release.json (404 Not Found)`);
      expect(binding("KY_CLOUD")).toMatchObject({ type: "plain_text", text: "1" });
    } finally {
      server.close();
    }
  });

  it("refuses a release image that isn't pinned on ghcr.io", async () => {
    account.paid = true;
    current = { ...release("r1"), image: "docker.io/someone/ky-cloud:latest" };

    await expect(setUp()).rejects.toThrow("isn't one ky copies");
    expect(script()).toBeUndefined();
  });
});

describe("ky login", () => {
  /** Where `ky login` keeps the token, in the fake Keychain. */
  const KEPT = "ky cloudflare/someone";

  it("keeps a token that can deploy ky, which a deploy then signs in with", async () => {
    const ky = await setUp();

    signedIn = undefined;
    expect(await doctor(ky)).toEqual({ code: 1, next: "Next: ky login" });

    output = [];
    expect(await Cli.ky(["login"], ky)).toBe(0);
    expect(ky.system.keychain.get(KEPT)).toBe("token-from-the-tokens-page");
    expect(output.at(-1)).toContain(`in the Keychain, as "ky cloudflare" for someone`);
    expect((await ky.login()).login).toBe("ky login");
    expect(await deployCommand(ky)).toBe(0);

    expect(await Cli.ky(["logout"], ky)).toBe(0);
    expect(ky.system.keychain.has(KEPT)).toBe(false);
    expect(await doctor(ky)).toEqual({ code: 1, next: "Next: ky login" });
  });

  it("keeps nothing it can't sign in with, or that can't manage Access", async () => {
    const ky = await setUp();

    output = [];
    pasted = "not a token";
    expect(await Cli.ky(["login"], ky)).toBe(1);
    expect(output.at(-1)).toContain("That isn't a Cloudflare API token");

    output = [];
    pasted = NO_ORGANIZATION_TOKEN;
    expect(await Cli.ky(["login"], ky)).toBe(1);
    expect(output.at(-1)).toContain("lacks Access: Organizations, Identity Providers, and Groups: Read");
    expect(output.at(-1)).toContain("Nothing was saved");
    expect(ky.system.keychain.has(KEPT)).toBe(false);
  });

  it("keeps it in a file only the user reads, off macOS", async () => {
    const ky = context(path.join(await mkdtemp(path.join(tmpdir(), "ky-cli-")), "wrangler.local.jsonc"), await fakeSystem("linux"));

    await initCommand(ky, { account: "Test", name: "ky", email: EMAIL });
    expect(await Cli.ky(["login"], ky)).toBe(0);
    const file = path.join(ky.system.config, "ky", "cloudflare-token");

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await savedToken(ky.system)).toBe("token-from-the-tokens-page");
  });
});

describe("a deploy", () => {
  it("checks the login can do all of it before it changes anything", async () => {
    const ky = await setUp();

    signedIn = new Cloudflare(NO_ORGANIZATION_TOKEN, "CLOUDFLARE_API_TOKEN");
    fake.requests.splice(0);
    await expect(deployCommand(ky)).rejects.toThrow(
      lacks("CLOUDFLARE_API_TOKEN", ["Access: Organizations, Identity Providers, and Groups: Read"])
    );
    expect(fake.requests.filter((request) => !request.startsWith("GET"))).toEqual([]);
  });

  it("restarts the runner once the upgrade is live, not before", async () => {
    const ky = await setUp();
    const { system } = ky;

    await writeSettings(settingsFile(system), {
      url: "https://ky.test.workers.dev",
      name: "mac",
      token: { file: path.join(system.config, "ky", "runner-token") },
      workdir: system.home,
      repos: [],
      permissionMode: "default",
      chrome: false,
      agents: { claude: true, codex: false },
      ports: []
    });
    system.loaded.add(system.label);

    output = [];
    current = release("r2");
    expect(await upgradeCommand(ky)).toBe(0);
    const upgraded = output.findIndex((line) => line.includes("Upgrading the Worker from r1 to r2"));
    const restarted = output.findIndex((line) => line.includes("Restarted the runner for mac"));

    expect(upgraded).toBeGreaterThan(-1);
    expect(restarted).toBeGreaterThan(upgraded);
  });
});

describe("a second ky, by name", () => {
  it("is set up with `ky init --as`, and deployed, upgraded and checked by its name", async () => {
    const ky = await setUp();

    expect(await Cli.ky(["init", "--as", "work", "--account", "Test", "--email", EMAIL], ky)).toBe(0);
    const work = path.join(path.dirname(ky.overlay), "work", "wrangler.local.jsonc");

    expect((await readOverlay(work))?.name).toBe("work");
    expect(script("work")).toBeDefined();

    current = release("r2");
    output = [];
    expect(await Cli.ky(["upgrade", "work"], ky)).toBe(0);
    expect(output.join("\n")).toContain("Upgrading the Worker from r1 to r2");

    output = [];
    expect(await Cli.ky(["doctor", "work"], ky)).toBe(0);
    expect(await Cli.ky(["doctor", "ky"], ky)).toBe(1);
    expect(output.at(-1)).toBe("Next: ky upgrade");

    output = [];
    expect(await Cli.ky(["doctor", "nope"], ky)).toBe(1);
    expect(output.at(-1)).toContain("No ky named nope on this computer: set one up with `ky init --as nope`");
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

describe("how ky looks", () => {
  /** The steps the run reported, as plain output names them. */
  const steps = () => output.filter((line) => line.startsWith("· ")).map((line) => line.slice(2));

  /** Runs `then` as though in a terminal, with NO_COLOR set or not. */
  function inTerminal(noColor: boolean, then: () => void) {
    const [tty, color] = [process.stdout.isTTY, process.env.NO_COLOR];

    process.stdout.isTTY = true;

    if (noColor) process.env.NO_COLOR = "1";
    else delete process.env.NO_COLOR;

    try {
      then();
    } finally {
      process.stdout.isTTY = tty;

      if (color === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = color;
    }
  }

  it("reports every step of a first ky init, upgrade and teardown, in order", async () => {
    const ky = await fresh();

    account.subdomain = undefined;
    await initCommand(ky, { account: "Test", name: "ky", email: EMAIL, subdomain: "test" });
    expect(steps()).toEqual([
      "Signed in with CLOUDFLARE_API_TOKEN",
      "Cloudflare account Test",
      "Access team: test.cloudflareaccess.com",
      "Turning on test.workers.dev",
      "Checking the names are free",
      "Skipping the cloud machine: this ky's release has no cloud machine image",
      "Setting up the bucket",
      "Setting up Access",
      "Uploading the web app",
      "Uploading the Worker",
      "Turning on workers.dev"
    ]);

    output = [];
    current = release("r2");
    await upgradeCommand(ky);
    expect(steps()).toEqual([
      "Checking what's in the account",
      "Skipping the cloud machine: this ky's release has no cloud machine image",
      "Setting up the bucket",
      "Setting up Access",
      "Uploading the web app",
      "Upgrading the Worker from r1 to r2",
      "Turning on workers.dev"
    ]);

    output = [];
    await teardownCommand(ky, "ky");
    expect(steps()).toEqual([
      "Checking what's in the account",
      "Removing the Worker and its data",
      "Removing the Access apps",
      "Emptying and removing the bucket ky-files",
      "Checking nothing is left"
    ]);
  });

  it("prints plain lines, without escape codes, when piped", async () => {
    const ky = await setUp();

    await run(ky, "ky doctor");
    await run(ky, "ky deploy");
    await run(ky, "ky --help");
    expect(output.join("\n")).not.toContain("\u001b");
    expect(banner()).not.toContain("\u001b");
  });

  it("colors a terminal's output, and not under NO_COLOR", () => {
    inTerminal(false, () => {
      expect(banner()).toContain("\u001b[38;5;214m█");
      expect(bold("ky")).toBe("\u001b[1mky\u001b[0m");
    });
    inTerminal(true, () => {
      expect(banner()).not.toContain("\u001b");
      expect(banner()).toContain("█▄▀   ▀▄▄█");
      expect(bold("ky")).toBe("ky");
    });
  });
});

describe("the release pack", () => {
  /** r1's files as `pnpm compile` lays them out, release.json pinning the rest, in a pack. */
  async function packed(tamper?: (files: Map<string, Uint8Array>) => void) {
    const r1 = release("r1");

    const files = new Map<string, Uint8Array>([
      ["SKILL.md", encode(r1.skill)],
      ...[...r1.modules].map(([module, content]) => [`worker/${module}`, content] as const),
      ...[...r1.assets].map(([asset, content]) => [`assets${asset}`, content] as const)
    ]);

    const bundle = bundleOf(files);

    files.set("release.json", encode(JSON.stringify({ version: r1.version, bundle, config: r1.config })));
    tamper?.(files);

    const pack = path.join(await mkdtemp(path.join(tmpdir(), "ky-release-")), "release.pack");

    await writeFile(pack, packOf(files));
    useRelease(pack);

    return { ...r1, bundle };
  }

  it("carries the release the compiled ky deploys", async () => {
    const r1 = await packed();
    const loaded = await loadRelease();

    expect(r1.bundle).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(loaded).toEqual({ ...r1, modules: new Map([...r1.modules].map(([name, content]) => [name, Buffer.from(content)])), assets: expect.any(Map) });
    expect([...loaded.assets.keys()].sort()).toEqual(["/index.html", "/manifest.webmanifest"]);
  });

  it("refuses a release whose files aren't the ones release.json pins", async () => {
    await packed((files) => files.set("worker/index.js", encode("export default { fetch() {} }")));
    await expect(loadRelease()).rejects.toThrow(/aren't the ones its release.json pins/);
    await packed((files) => files.set("assets/extra.js", encode("")));
    await expect(loadRelease()).rejects.toThrow(/aren't the ones its release.json pins/);
  });

  it("names its version and what it is, so install.sh tells it from another ky", async () => {
    const ky = await fresh();

    output = [];
    expect(await Cli.ky(["--version"], ky)).toBe(0);
    expect(await Cli.ky(["version"], ky)).toBe(0);
    expect(output).toEqual([`ky r1 (${Cli.IDENTITY})`, `ky r1 (${Cli.IDENTITY})`]);
  });
});
