import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { Cloudflare } from "../../cli/cloudflare.ts";
import { type Context, deployCommand, doctorCommand, teardownCommand, upgradeCommand } from "../../cli/commands.ts";
import { readOverlay } from "../../cli/config.ts";
import { BYPASS } from "../../cli/deployer.ts";
import { initCommand } from "../../cli/init.ts";
import { loadRelease, packOf, type Release, releaseFiles, useRelease } from "../../cli/release.ts";
import { type FakeAccount, type FakeCloudflare, fakeAccount, fakeCloudflare } from "../fakes/cloudflare.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

const HOST = "ky.test.workers.dev";

const EMAIL = "owner@example.com";

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

let current: Release;

function context(overlay: string): Context {
  return {
    overlay,
    release: async () => current,
    login: async () => new Cloudflare("test-token", "CLOUDFLARE_API_TOKEN"),
    print: (line) => output.push(line)
  };
}

const script = () => account.scripts.get("ky");

const apps = () => [...account.apps.values()];

async function setUp(): Promise<Context> {
  const ky = context(path.join(await mkdtemp(path.join(tmpdir(), "ky-cli-")), "wrangler.local.jsonc"));

  await initCommand(ky, { account: "Test", name: "ky", email: EMAIL });

  return ky;
}

beforeEach(async () => {
  account = fakeAccount("acc", "Test", { subdomain: "test", team: "test.cloudflareaccess.com" });
  fake = await fakeCloudflare(account);
  process.env.CLOUDFLARE_API_BASE_URL = fake.url;
  output = [];
  current = release("r1");
});

afterEach(async () => {
  delete process.env.CLOUDFLARE_API_BASE_URL;
  await fake.close();
});

describe("ky init and deploy", () => {
  it("deploys the Worker with its bindings, every migration, ACCESS_* and a KY_TOKEN shown once", async () => {
    const ky = await setUp();
    const worker = script();
    const bindings = worker?.metadata.bindings ?? [];
    const text = (name: string) => bindings.find((binding) => binding.name === name)?.text;

    expect(await readOverlay(ky.overlay)).toEqual({
      account_id: "acc",
      name: "ky",
      r2_buckets: [{ binding: "FILES", bucket_name: "ky-files" }],
      vars: { ACCESS_EMAILS: EMAIL }
    });
    expect(worker).toMatchObject({ tags: ["ky", "ky-release-r1"], migrationTag: "v2", workersDev: true, modules: ["index.js", "assets/models.js"] });
    expect(worker?.migrations).toEqual([
      { new_tag: "v2", steps: [{ new_sqlite_classes: ["PiAgent"] }, { new_sqlite_classes: ["Vault"] }] }
    ]);
    expect(bindings).toEqual(
      expect.arrayContaining([
        { type: "ai", name: "AI" },
        { type: "r2_bucket", name: "FILES", bucket_name: "ky-files" },
        { type: "durable_object_namespace", name: "PiAgent", class_name: "PiAgent" },
        { type: "durable_object_namespace", name: "Vault", class_name: "Vault" },
        { type: "assets", name: "ASSETS" }
      ])
    );
    expect([text("ACCESS_TEAM_DOMAIN"), text("ACCESS_EMAILS")]).toEqual(["test.cloudflareaccess.com", EMAIL]);
    expect(text("ACCESS_AUD")).toBe(apps().find((app) => app.name === "ky")?.aud);
    expect(worker?.metadata.keep_bindings).toEqual(["secret_text"]);
    expect([...account.buckets.keys()]).toEqual(["ky-files"]);
    const token = worker?.secrets.get("KY_TOKEN");

    expect(token).toMatch(/^[\w-]{32}$/);
    expect(output.filter((line) => line.includes(String(token)))).toHaveLength(1);
    expect(output).toContain(`ky is live at https://${HOST}, behind Access for ${EMAIL}`);
  });

  it("sets up an Access app for the owner and a bypass app for the C2 paths", async () => {
    await setUp();

    expect(apps()).toEqual([
      expect.objectContaining({
        name: "ky",
        type: "self_hosted",
        destinations: [{ type: "public", uri: HOST }],
        policies: [{ name: "owner", decision: "allow", include: [{ email: { email: EMAIL } }] }]
      }),
      expect.objectContaining({
        name: "ky bypass",
        type: "self_hosted",
        destinations: BYPASS.map((bypass) => ({ type: "public", uri: `${HOST}${bypass}` })),
        policies: [{ name: "runners and files", decision: "bypass", include: [{ everyone: {} }] }]
      })
    ]);
    expect(BYPASS).toEqual(["/runner/*", "/api/runners/pair", "/api/files", "/manifest.webmanifest", "/icons/*"]);
  });

  it("upgrades without running migrations again, keeps the KY_TOKEN and the Access apps, and runs only a new migration", async () => {
    const ky = await setUp();
    const token = script()?.secrets.get("KY_TOKEN");

    output = [];
    expect(await upgradeCommand(ky)).toBe(0);
    expect(output).toEqual(["Already on r1"]);

    current = release("r2");
    await upgradeCommand(ky);
    expect(script()).toMatchObject({ tags: ["ky", "ky-release-r2"], migrationTag: "v2" });
    expect(script()?.migrations).toHaveLength(1);
    expect(script()?.metadata.migrations).toBeUndefined();
    expect(script()?.secrets.get("KY_TOKEN")).toBe(token);
    expect(output.some((line) => line.includes("KY_TOKEN"))).toBe(false);
    expect(output).toContain(`ky r2 is live at https://${HOST} (was r1)`);
    expect(apps()).toHaveLength(2);

    const config = release("r3").config;

    current = release("r3", { ...config, migrations: [...(config.migrations ?? []), { tag: "v3", deleted_classes: ["Vault"] }] });
    await deployCommand(ky);
    expect(script()?.migrations.at(-1)).toEqual({ old_tag: "v2", new_tag: "v3", steps: [{ deleted_classes: ["Vault"] }] });
    expect(script()?.migrationTag).toBe("v3");
  });

  it("uploads only the web app's files Cloudflare doesn't have", async () => {
    const ky = await setUp();
    const uploaded = new Set(account.assets);

    expect(uploaded.size).toBe(2);
    current = { ...release("r2"), assets: new Map([...release("r2").assets, ["/new.js", encode("new")]]) };
    await deployCommand(ky);
    expect(account.assets.size).toBe(3);
  });

  it("refuses a Worker of that name ky didn't deploy, and writes nothing", async () => {
    account.scripts.set("ky", { tags: [], migrations: [], metadata: { main_module: "index.js" }, modules: [], secrets: new Map(), workersDev: true });
    const ky = context(path.join(await mkdtemp(path.join(tmpdir(), "ky-cli-")), "wrangler.local.jsonc"));

    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow("ky didn't deploy it");
    expect(existsSync(ky.overlay)).toBe(false);
    expect(account.apps.size).toBe(0);
  });

  it("asks for Zero Trust, a workers.dev subdomain, and a token that can manage Access", async () => {
    const ky = context(path.join(await mkdtemp(path.join(tmpdir(), "ky-cli-")), "wrangler.local.jsonc"));

    account.team = undefined;
    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow(
      "Turn on Zero Trust at https://one.dash.cloudflare.com/acc"
    );
    account.team = "test.cloudflareaccess.com";
    fake.forbidAccess = true;
    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow(
      /signed in with CLOUDFLARE_API_TOKEN\)\. A token from https:\/\/dash\.cloudflare\.com\/profile\/api-tokens/
    );
    fake.forbidAccess = false;
    account.subdomain = undefined;
    await expect(initCommand(ky, { account: "acc", name: "ky", email: EMAIL })).rejects.toThrow("Pass --subdomain <name>");
    await initCommand(ky, { account: "acc", name: "ky", email: EMAIL, subdomain: "test" });
    expect(account.subdomain).toBe("test");
    expect(script()).toBeDefined();
  });
});

describe("ky doctor", () => {
  it("prints each check and the command that fixes the first one missing", async () => {
    const ky = context(path.join(await mkdtemp(path.join(tmpdir(), "ky-cli-")), "wrangler.local.jsonc"));

    const doctor = async () => {
      output = [];
      const code = await doctorCommand(ky, false);

      return { code, next: output.at(-1) };
    };

    expect(await doctor()).toEqual({ code: 1, next: "Next: ky init" });
    await initCommand(ky, { account: "acc", name: "ky", email: EMAIL });
    expect(await doctor()).toEqual({ code: 0, next: "All good" });
    expect(output.slice(0, -1)).toEqual([
      `✓ Config: ${ky.overlay}`,
      "✓ Cloudflare login: CLOUDFLARE_API_TOKEN",
      "✓ Zero Trust: test.cloudflareaccess.com",
      "✓ workers.dev subdomain: test",
      "✓ Worker: ky",
      "✓ Release: r1",
      "✓ Migrations: v2",
      "✓ KY_TOKEN: set",
      "✓ Bucket: ky-files",
      `✓ Access app "ky": ${HOST}`,
      '✓ Access app "ky bypass": 5 paths',
      `✓ workers.dev: https://${HOST}`
    ]);

    current = release("r2");
    expect(await doctor()).toEqual({ code: 1, next: "Next: ky upgrade" });
    expect(output).toContain("✗ Release: r1, this ky is r2");

    current = release("r1");
    account.apps.delete([...account.apps.values()].find((app) => app.name === "ky bypass")?.id ?? "");
    expect(await doctor()).toEqual({ code: 1, next: "Next: ky deploy" });
    expect(output).toContain('✗ Access app "ky bypass": missing');

    account.scripts.delete("ky");
    expect(await doctor()).toEqual({ code: 1, next: "Next: ky deploy" });
    expect(output).toContain("✗ Worker: no Worker named ky");

    account.team = undefined;
    await doctorCommand(ky, true);
    expect(JSON.parse(output.at(-1) ?? "")).toMatchObject({
      checks: expect.arrayContaining([{ name: "Zero Trust", ok: false, detail: "off", next: expect.stringContaining("one.dash.cloudflare.com/acc") }]),
      next: expect.stringContaining("turn it on")
    });

    const signedOut = { ...ky, login: () => Promise.reject(new Error("Not signed in to Cloudflare")) };

    output = [];
    expect(await doctorCommand(signedOut, false)).toBe(1);
    expect(output.slice(-2)).toEqual(["✗ Cloudflare login: Not signed in to Cloudflare", "Next: wrangler login"]);
  });
});

describe("ky teardown", () => {
  it("removes the Access apps, the Worker with its data and secrets, the emptied bucket, then the overlay", async () => {
    const ky = await setUp();

    account.buckets.get("ky-files")?.add("chat/a.png").add("chat/b.png");
    await expect(teardownCommand(ky, undefined)).rejects.toThrow("ky teardown --confirm ky");
    await expect(teardownCommand(ky, "other")).rejects.toThrow("ky teardown --confirm ky");
    expect(script()).toBeDefined();

    expect(await teardownCommand(ky, "ky")).toBe(0);
    expect(account.scripts.size).toBe(0);
    expect(account.buckets.size).toBe(0);
    expect(account.apps.size).toBe(0);
    expect(existsSync(ky.overlay)).toBe(false);
    expect(output.at(-1)).toBe("Removed ky");
  });

  it("leaves a Worker of that name ky didn't deploy alone", async () => {
    const ky = await setUp();

    script()?.tags.splice(0);
    await expect(teardownCommand(ky, "ky")).rejects.toThrow("ky didn't deploy it");
    expect(script()).toBeDefined();
    expect(account.apps.size).toBe(2);
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
