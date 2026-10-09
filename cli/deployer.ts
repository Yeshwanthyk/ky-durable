/**
 * Deploys a release to the user's account, checks what's there, and removes it, with direct
 * Cloudflare API calls. What to deploy is the release's generic wrangler.jsonc with the user's
 * overlay merged over it (C6); everything else is found again each run, so nothing is kept between
 * runs.
 *
 * ky changes and removes only what it made. A Worker the CLI deployed carries the `ky` tag and its
 * release's version; one of the same name without the tag (one `pnpm run deploy` made, say) is
 * never changed or removed. A bucket the CLI made holds a marker object; one without it is never
 * adopted or emptied, and teardown leaves a bucket another Worker binds. Access apps are the ones
 * that guard the Worker's address, whatever they're called.
 */
import { createHash, randomBytes } from "node:crypto";
import * as R2 from "@distilled.cloud/cloudflare/r2";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as ZeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Unstable_RawConfig } from "wrangler";
import { type Cloudflare, getService, refused, SCOPES, tokenPage } from "./cloudflare.ts";
import { emails } from "./config.ts";
import type { Release } from "./release.ts";

/** C2: what Access lets through without a login; each of these checks its own bearer, or is public. */
export const BYPASS = ["/runner/*", "/api/runners/pair", "/api/files", "/manifest.webmanifest", "/icons/*"];

/** The tag every Worker the CLI deploys carries, and the one that names its release. */
const TAG = "ky";

const RELEASE_TAG = "ky-release-";

/** The object every bucket the CLI makes holds, so a bucket without it is never adopted or removed. */
const MARKER = ".ky";

/** What the deployer turns into the Worker's metadata; anything else in a config is refused. */
const DEPLOYS = new Set([
  "$schema",
  "account_id",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "version_metadata",
  "r2_buckets",
  "browser",
  "worker_loaders",
  "ai",
  "assets",
  "durable_objects",
  "migrations",
  "observability",
  "vars",
  "vpc_services"
]);

/** Why a key wrangler.jsonc may hold isn't deployed here. */
const REFUSED = new Map([
  // CM: the cloud machine's Container app deploys here, after the script, from its namespace, and
  // teardown removes it before the Worker.
  ["containers", "Container apps arrive with the cloud machine"]
]);

type Binding = Workers.PutScriptBinding;

type Migrations = NonNullable<Unstable_RawConfig["migrations"]>;

type AccessApp = Parameters<typeof ZeroTrust.createAccessApplicationForAccount>[0];

type FoundApp = Awaited<ReturnType<typeof accessApps>>[number];

/** One deploy target: an account, the config to deploy there, and the overlay it came from. */
export type Target = { cloudflare: Cloudflare; config: Unstable_RawConfig; settings: string };

export type Deployed = {
  url: string;
  /** The release the Worker ran before, or undefined when this deploy created it. */
  from?: string;
  /** KY_TOKEN, when this deploy set one; it's shown once and kept nowhere else. */
  token?: string;
};

/** One piece `ky doctor` checks, and what fixes it. */
export type Check = { name: string; ok: boolean; detail: string; next?: string };

type Script = Awaited<ReturnType<typeof scripts>>[number];

type Names = ReturnType<typeof names>;

/** A Worker or bucket of this deploy's name that ky didn't make. */
export class NameTaken extends Error {
  /** What's taken, without what to do about it. */
  readonly taken: string;

  constructor(taken: string, settings: string) {
    super(`${taken}; ${rename(settings)}`);
    this.taken = taken;
  }
}

function rename(settings: string): string {
  return `pick another name: set "name" in ${settings}, then run \`ky deploy\``;
}

/** Where the user turns Zero Trust on. */
export function zeroTrustPage(accountId: string): string {
  return `https://one.dash.cloudflare.com/${accountId}`;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === "") throw new Error(`The config has no ${what}; run \`ky init\``);

  return value;
}

/** The names this deploy's resources go by: each bucket is the Worker's name and its binding's. */
function names(config: Unstable_RawConfig) {
  const script = required(config.name, "name");

  return {
    account: required(config.account_id, "account_id"),
    script,
    access: script,
    bypass: `${script} bypass`,
    buckets: (config.r2_buckets ?? []).map((bucket) => ({
      binding: bucket.binding,
      name: `${script}-${bucket.binding.toLowerCase().replaceAll("_", "-")}`
    }))
  };
}

/** The release a Worker the CLI deployed runs, from its tags. */
function releaseOf(script: Script): string | undefined {
  return script.tags?.find((tag) => tag.startsWith(RELEASE_TAG))?.slice(RELEASE_TAG.length);
}

function scripts(cloudflare: Cloudflare, accountId: string) {
  return cloudflare.list(Workers.listScripts.items({ accountId }));
}

/** The Worker of this name, whoever deployed it. */
async function existing(cloudflare: Cloudflare, accountId: string, name: string): Promise<Script | undefined> {
  return (await scripts(cloudflare, accountId)).find((candidate) => candidate.id === name);
}

function ours(script: Script): boolean {
  return script.tags?.includes(TAG) ?? false;
}

/** The Worker of this name, refusing one the CLI didn't deploy. */
async function findScript({ cloudflare, settings }: Target, name: Names): Promise<Script | undefined> {
  const script = await existing(cloudflare, name.account, name.script);

  if (script && !ours(script)) throw new NameTaken(`A Worker named ${name.script} is already in this account and ky didn't deploy it`, settings);

  return script;
}

/** The migration the Worker last ran, read where wrangler reads it. */
async function migrationTag(cloudflare: Cloudflare, accountId: string, name: string): Promise<string | undefined> {
  const service = await cloudflare.run(getService({ accountId, serviceName: name }));

  return service.defaultEnvironment.script.migrationTag ?? undefined;
}

/** Whether the bucket is there, and whether the CLI made it. */
async function bucketState(cloudflare: Cloudflare, accountId: string, bucketName: string): Promise<"missing" | "ours" | "theirs"> {
  if (!(await cloudflare.find(R2.getBucket({ accountId, bucketName }), "NoSuchBucket"))) return "missing";
  const marked = await cloudflare.list(R2.listObjects.items({ accountId, bucketName, prefix: MARKER }));

  return marked.some((object) => object.key === MARKER) ? "ours" : "theirs";
}

/**
 * The deploy's Worker, when there is one, once neither it nor a bucket of the deploy's names is
 * one ky didn't make; it writes nothing.
 */
export async function claim(target: Target): Promise<Script | undefined> {
  const name = names(target.config);
  const script = await findScript(target, name);

  for (const bucket of name.buckets)
    if ((await bucketState(target.cloudflare, name.account, bucket.name)) === "theirs")
      throw new NameTaken(`A bucket named ${bucket.name} is already in this account and ky didn't create it`, target.settings);

  return script;
}

async function host(cloudflare: Cloudflare, accountId: string, name: string): Promise<string> {
  const subdomain = await cloudflare.find(Workers.getSubdomain({ accountId }), "SubdomainNotFound");

  if (!subdomain?.subdomain) throw new Error("This account has no workers.dev subdomain yet: run `ky init --subdomain <name>`");

  return `${name}.${subdomain.subdomain}.workers.dev`;
}

/** The account's Access team domain, `<team>.cloudflareaccess.com`; undefined until Zero Trust is on. */
export async function teamDomain(cloudflare: Cloudflare, accountId: string): Promise<string | undefined> {
  const organization = await cloudflare.find(ZeroTrust.listOrganizationsForAccount({ accountId }), "OrganizationNotFound");

  return organization?.authDomain ?? undefined;
}

/** The config's migrations the Worker hasn't run, as one upload: all of them on the first deploy. */
function pendingMigrations(migrations: Migrations, applied: string | undefined) {
  const from = applied ? migrations.findIndex((migration) => migration.tag === applied) : -1;

  if (applied && from < 0) throw new Error(`The Worker ran migration ${applied}, which this release doesn't have`);
  const pending = migrations.slice(from + 1);

  if (pending.length === 0) return undefined;

  return {
    oldTag: applied,
    newTag: pending.at(-1)?.tag,
    steps: pending.map((migration) => ({
      newSqliteClasses: migration.new_sqlite_classes,
      newClasses: migration.new_classes,
      deletedClasses: migration.deleted_classes,
      renamedClasses: migration.renamed_classes
    }))
  };
}

/** The Worker's bindings, from the config, with its buckets and `env` added as plain text. */
function bindings(config: Unstable_RawConfig, buckets: Names["buckets"], env: Record<string, string>): Binding[] {
  for (const key of Object.keys(config))
    if (!DEPLOYS.has(key)) throw new Error(`ky deploy can't deploy \`${key}\`: ${REFUSED.get(key) ?? "use `pnpm run deploy` from a checkout"}`);

  const single = (binding: { binding?: string } | undefined) => (binding?.binding ? [binding.binding] : []);

  return [
    ...single(config.version_metadata).map((name): Binding => ({ type: "version_metadata", name })),
    ...single(config.ai).map((name): Binding => ({ type: "ai", name })),
    ...single(config.browser).map((name): Binding => ({ type: "browser", name })),
    ...single(config.assets).map((name): Binding => ({ type: "assets", name })),
    ...(config.worker_loaders ?? []).map((loader): Binding => ({ type: "worker_loader", name: loader.binding })),
    ...buckets.map((bucket): Binding => ({ type: "r2_bucket", name: bucket.binding, bucketName: bucket.name })),
    ...(config.durable_objects?.bindings ?? []).map(
      (object): Binding => ({ type: "durable_object_namespace", name: object.name, className: object.class_name })
    ),
    ...(config.vpc_services ?? []).map((service): Binding => ({ type: "vpc_service", name: service.binding, serviceId: service.service_id })),
    ...Object.entries({ ...config.vars, ...env }).map(
      ([name, value]): Binding => (Value.Check(Type.String(), value) ? { type: "plain_text", name, text: value } : { type: "json", name, json: value })
    )
  ];
}

const TYPES = new Map([
  ["js", "application/javascript"],
  ["css", "text/css"],
  ["html", "text/html"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["json", "application/json"],
  ["woff2", "font/woff2"],
  ["ico", "image/x-icon"],
  ["txt", "text/plain"],
  ["webmanifest", "application/manifest+json"]
]);

/** The web app's manifest, path to hash, and its files by hash; a file's hash is wrangler's. */
function hashed(assets: Release["assets"]) {
  const files = new Map<string, File>();
  const manifest: Record<string, { hash: string; size: number }> = {};

  for (const [path, content] of assets) {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const hash = createHash("sha256").update(content).update(ext).digest("hex").slice(0, 32);

    manifest[path] = { hash, size: content.byteLength };
    files.set(hash, new File([Buffer.from(content).toString("base64")], hash, { type: TYPES.get(ext) ?? "application/octet-stream" }));
  }

  return { manifest, files };
}

/** Uploads the web app's files Cloudflare doesn't have yet, and returns the token that deploys them. */
async function uploadAssets(cloudflare: Cloudflare, accountId: string, scriptName: string, assets: Release["assets"]): Promise<string> {
  const { manifest, files } = hashed(assets);
  const session = await cloudflare.run(Workers.createScriptAssetUpload({ accountId, scriptName, manifest }));
  const jwtToken = session.jwt ?? "";
  let jwt = jwtToken;

  for (const bucket of session.buckets ?? []) {
    const body = Object.fromEntries(bucket.flatMap((hash) => files.get(hash) ?? []).map((file) => [file.name, file]));
    const uploaded = await cloudflare.run(Workers.createAssetUpload({ accountId, base64: true, body, jwtToken }));

    jwt = uploaded.jwt ?? jwt;
  }

  return jwt;
}

/** A destination as Access compares it: no scheme, no trailing slash, lower case. */
function normal(uri: string): string {
  return uri.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function accessApps(cloudflare: Cloudflare, accountId: string) {
  return cloudflare.list(ZeroTrust.listAccessApplicationsForAccount.items({ accountId }));
}

/** What the app guards, normalised. */
function guards(app: FoundApp): Set<string> {
  const destinations = ("destinations" in app ? app.destinations : undefined) ?? [];
  const uris = destinations.flatMap((destination) => ("uri" in destination && destination.uri ? [destination.uri] : []));
  const domain = "domain" in app && app.domain ? [app.domain] : [];

  return new Set([...uris, ...domain].map(normal));
}

/** The Access apps that guard this address: the owner's covers it, the bypass app C2's paths under it. */
async function accessFor(cloudflare: Cloudflare, accountId: string, address: string) {
  const apps = await accessApps(cloudflare, accountId);
  const paths = BYPASS.map((path) => normal(`${address}${path}`));
  const owner = apps.find((app) => guards(app).has(normal(address)));

  return { owner, bypass: apps.find((app) => app !== owner && paths.some((path) => guards(app).has(path))), paths };
}

/** Creates the Access app, or updates the one found, and returns its audience tag. */
async function saveApp(cloudflare: Cloudflare, found: FoundApp | undefined, app: AccessApp): Promise<string> {
  const saved = found?.id
    ? await cloudflare.run(ZeroTrust.updateAccessApplicationForAccount({ ...app, appId: found.id }))
    : await cloudflare.run(ZeroTrust.createAccessApplicationForAccount(app));

  if (!("aud" in saved) || !saved.aud) throw new Error(`Cloudflare returned no audience tag for the Access app ${app.name}`);

  return saved.aud;
}

/** The Access app that lets only the owner in, and the one for C2's paths; returns the first's audience tag. */
async function ensureAccess(cloudflare: Cloudflare, name: Names, address: string, allowed: string[]): Promise<string> {
  const accountId = name.account;
  const found = await accessFor(cloudflare, accountId, address);

  const aud = await saveApp(cloudflare, found.owner, {
    accountId,
    type: "self_hosted",
    name: name.access,
    destinations: [{ type: "public", uri: address }],
    policies: [{ name: "owner", decision: "allow", include: allowed.map((email) => ({ email: { email } })) }]
  });

  await saveApp(cloudflare, found.bypass, {
    accountId,
    type: "self_hosted",
    name: name.bypass,
    destinations: BYPASS.map((path) => ({ type: "public", uri: `${address}${path}` })),
    policies: [{ name: "runners and files", decision: "bypass", include: [{ everyone: {} }] }]
  });

  return aud;
}

/** Makes the buckets that aren't there yet, each with the marker that says ky made it. */
async function ensureBuckets(cloudflare: Cloudflare, name: Names): Promise<void> {
  const accountId = name.account;

  for (const bucket of name.buckets) {
    if (await cloudflare.find(R2.getBucket({ accountId, bucketName: bucket.name }), "NoSuchBucket")) continue;
    await cloudflare.run(R2.createBucket({ accountId, name: bucket.name }));
    await cloudflare.run(
      R2.putObject({
        accountId,
        bucketName: bucket.name,
        objectName: MARKER,
        body: `ky made this bucket for the ${name.script} Worker; \`ky teardown\` removes it.`,
        contentType: "text/plain"
      })
    );
  }
}

/** A new KY_TOKEN, unless the Worker (when there is one) has it: it signs the owner in until Access replaces it (node A). */
async function newToken(cloudflare: Cloudflare, accountId: string, scriptName: string | undefined): Promise<string | undefined> {
  const secrets = scriptName ? await cloudflare.list(Workers.listScriptSecrets.items({ accountId, scriptName })) : [];

  return secrets.some((secret) => secret.name === "KY_TOKEN") ? undefined : Buffer.from(randomBytes(24)).toString("base64url");
}

/**
 * Deploys the release: buckets, the Access apps, the web app, then the Worker with its bindings,
 * the migrations it hasn't run, `ACCESS_*`, and a KY_TOKEN when it has none; then workers.dev.
 */
export async function deploy(target: Target, release: Release, say: (step: string) => void): Promise<Deployed> {
  const { cloudflare, config } = target;
  const name = names(config);
  const accountId = name.account;
  const allowed = emails(config);
  const address = await host(cloudflare, accountId, name.script);
  const team = await teamDomain(cloudflare, accountId);

  if (!team) throw new Error(`Zero Trust isn't on for this account: turn it on at ${zeroTrustPage(accountId)} (the free plan is enough), then run \`ky deploy\``);
  const script = await claim(target);
  const applied = script && (await migrationTag(cloudflare, accountId, name.script));

  say("Setting up the bucket");
  await ensureBuckets(cloudflare, name);
  say("Setting up Access");
  const aud = await ensureAccess(cloudflare, name, address, allowed);

  say("Uploading the web app");
  const jwt = await uploadAssets(cloudflare, accountId, name.script, release.assets);
  const token = await newToken(cloudflare, accountId, script && name.script);
  const secret: Binding[] = token ? [{ type: "secret_text", name: "KY_TOKEN", text: token }] : [];

  say(script ? `Upgrading the Worker from ${releaseOf(script) ?? "an unknown release"} to ${release.version}` : "Uploading the Worker");
  await cloudflare.run(
    Workers.putScript({
      accountId,
      scriptName: name.script,
      metadata: {
        mainModule: config.main,
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        assets: {
          jwt,
          config: { notFoundHandling: config.assets?.not_found_handling, runWorkerFirst: config.assets?.run_worker_first }
        },
        bindings: [
          ...bindings(config, name.buckets, { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ACCESS_EMAILS: allowed.join(",") }),
          ...secret
        ],
        keepBindings: ["secret_text"],
        migrations: pendingMigrations(config.migrations ?? [], applied),
        observability: config.observability ? { enabled: config.observability.enabled ?? false } : undefined,
        tags: [TAG, `${RELEASE_TAG}${release.version}`]
      },
      files: [...release.modules].map(([module, content]) => new File([Buffer.from(content)], module, { type: "application/javascript+module" }))
    })
  );

  say("Turning on workers.dev");
  await cloudflare.run(Workers.createScriptSubdomain({ accountId, scriptName: name.script, enabled: true, previewsEnabled: false }));

  return { url: `https://${address}`, from: script ? (releaseOf(script) ?? "an unknown release") : undefined, token };
}

/** The release the Worker runs, or undefined when there's no Worker. */
export async function deployedRelease(target: Target): Promise<string | undefined> {
  const script = await findScript(target, names(target.config));

  return script && (releaseOf(script) ?? "an unknown release");
}

type Checker = (check: Check) => boolean;

/** Every piece of a deploy, checked in order, each with what fixes it; a refused login is a failed check too. */
export async function inspect(target: Target, release: Release): Promise<Check[]> {
  const checks: Check[] = [];

  try {
    await inspectAccount(target, release, (check) => checks.push(check) > 0 && check.ok);
  } catch (error) {
    if (!refused(error)) throw error;
    checks.push({
      name: "Cloudflare permissions",
      ok: false,
      detail: `Cloudflare refused ${target.cloudflare.login}; ky needs ${SCOPES}`,
      next: `set CLOUDFLARE_API_TOKEN to a token from ${tokenPage()}, then run \`ky doctor\``
    });
  }

  return checks;
}

function bucketCheck(state: Awaited<ReturnType<typeof bucketState>>, bucketName: string, settings: string): Check {
  if (state === "ours") return { name: "Bucket", ok: true, detail: bucketName };

  if (state === "missing") return { name: "Bucket", ok: false, detail: `no bucket ${bucketName}`, next: "ky deploy" };

  return { name: "Bucket", ok: false, detail: `${bucketName} is a bucket ky didn't create`, next: rename(settings) };
}

/** Zero Trust, workers.dev, then the names the deploy needs, then the Worker. */
async function inspectAccount(target: Target, release: Release, check: Checker): Promise<void> {
  const { cloudflare, config, settings } = target;
  const name = names(config);
  const accountId = name.account;
  const team = await teamDomain(cloudflare, accountId);

  check({
    name: "Zero Trust",
    ok: Boolean(team),
    detail: team ?? "off",
    next: `turn it on at ${zeroTrustPage(accountId)} (the free plan is enough), then run \`ky deploy\``
  });
  const subdomain = (await cloudflare.find(Workers.getSubdomain({ accountId }), "SubdomainNotFound"))?.subdomain;

  if (!check({ name: "workers.dev subdomain", ok: Boolean(subdomain), detail: subdomain ?? "none", next: "ky init --subdomain <name>" })) return;
  const script = await existing(cloudflare, accountId, name.script);

  if (script && !ours(script)) {
    check({ name: "Worker", ok: false, detail: `${name.script} is a Worker ky didn't deploy`, next: rename(settings) });

    return;
  }

  for (const bucket of name.buckets) check(bucketCheck(await bucketState(cloudflare, accountId, bucket.name), bucket.name, settings));

  if (!script) {
    check({ name: "Worker", ok: false, detail: `no Worker named ${name.script}`, next: "ky deploy" });

    return;
  }

  check({ name: "Worker", ok: true, detail: name.script });
  await inspectWorker(target, release, script, `${name.script}.${subdomain}.workers.dev`, check);
}

/** The Worker's release, migrations, KY_TOKEN, Access apps and workers.dev. */
async function inspectWorker(target: Target, release: Release, script: Script, address: string, check: Checker): Promise<void> {
  const { cloudflare, config } = target;
  const name = names(config);
  const accountId = name.account;
  const deployed = releaseOf(script);
  const applied = await migrationTag(cloudflare, accountId, name.script);
  const latest = config.migrations?.at(-1)?.tag;

  check({
    name: "Release",
    ok: deployed === release.version,
    detail: deployed === release.version ? release.version : `${deployed ?? "unknown"}, this ky is ${release.version}`,
    next: "ky upgrade"
  });
  check({
    name: "Migrations",
    ok: applied === latest,
    detail: `${applied ?? "none"}${applied === latest ? "" : `, this release has ${latest}`}`,
    next: "ky deploy"
  });
  const secrets = await cloudflare.list(Workers.listScriptSecrets.items({ accountId, scriptName: name.script }));
  const hasToken = secrets.some((secret) => secret.name === "KY_TOKEN");

  check({ name: "KY_TOKEN", ok: hasToken, detail: hasToken ? "set" : "missing", next: "ky deploy" });

  for (const access of accessChecks(await accessFor(cloudflare, accountId, address), address)) check(access);
  const workersDev = await cloudflare.run(Workers.getScriptSubdomain({ accountId, scriptName: name.script }));

  check({ name: "workers.dev", ok: workersDev.enabled, detail: workersDev.enabled ? `https://${address}` : "off", next: "ky deploy" });
}

/** Whether an Access app guards the address, and whether the bypass app covers every C2 path under it. */
function accessChecks(access: Awaited<ReturnType<typeof accessFor>>, address: string): Check[] {
  const missing = access.paths.filter((path) => !access.bypass || !guards(access.bypass).has(path));

  return [
    { name: "Access for the owner", ok: Boolean(access.owner), detail: access.owner ? address : `no Access app guards ${address}`, next: "ky deploy" },
    {
      name: "Access bypass",
      ok: missing.length === 0,
      detail: missing.length === 0 ? `${BYPASS.length} paths` : `doesn't cover ${missing.join(", ")}`,
      next: "ky deploy"
    }
  ];
}

/** The other Workers that bind the bucket. */
async function bindersOf(cloudflare: Cloudflare, accountId: string, bucketName: string, except: string): Promise<string[]> {
  const binders: string[] = [];

  for (const script of await scripts(cloudflare, accountId)) {
    if (!script.id || script.id === except) continue;
    const settings = await cloudflare.run(Workers.getScriptScriptAndVersionSetting({ accountId, scriptName: script.id }));

    if (settings.bindings?.some((binding) => binding.type === "r2_bucket" && "bucketName" in binding && binding.bucketName === bucketName))
      binders.push(script.id);
  }

  return binders;
}

/** What teardown does with the bucket: removes it, leaves it (ky didn't create it, or another Worker binds it), or nothing once it's gone. */
async function bucketFate(cloudflare: Cloudflare, accountId: string, bucketName: string, script: string): Promise<"remove" | "gone" | { leave: string }> {
  const state = await bucketState(cloudflare, accountId, bucketName);

  if (state === "missing") return "gone";

  if (state === "theirs") return { leave: "ky didn't create it" };
  const binders = await bindersOf(cloudflare, accountId, bucketName, script);

  return binders.length > 0 ? { leave: `${binders.join(", ")} binds it` } : "remove";
}

/** What teardown removes once the Worker is gone (the Access apps that guard its address, the buckets ky made that no other Worker binds), and what it leaves. */
async function removable({ cloudflare, config }: Target) {
  const name = names(config);
  const accountId = name.account;
  const subdomain = (await cloudflare.find(Workers.getSubdomain({ accountId }), "SubdomainNotFound"))?.subdomain;
  const access = subdomain ? await accessFor(cloudflare, accountId, `${name.script}.${subdomain}.workers.dev`) : undefined;
  const buckets: string[] = [];
  const kept: string[] = [];

  for (const bucket of name.buckets) {
    const fate = await bucketFate(cloudflare, accountId, bucket.name, name.script);

    if (fate === "remove") buckets.push(bucket.name);
    else if (fate !== "gone") kept.push(`the bucket ${bucket.name}: ${fate.leave}`);
  }

  return { apps: [access?.owner, access?.bypass].flatMap((app) => (app ? [app] : [])), buckets, kept };
}

/** Removes the Worker (its Durable Objects' data and secrets go with it), then its Access apps and buckets. */
export async function teardown(target: Target, say: (step: string) => void): Promise<void> {
  const { cloudflare, config, settings } = target;
  const name = names(config);
  const accountId = name.account;
  const script = await existing(cloudflare, accountId, name.script);

  if (script && !ours(script))
    throw new Error(
      `A Worker named ${name.script} is in this account and ky didn't deploy it, so ky teardown leaves it alone, with its Access apps and buckets; delete ${settings} to forget these settings`
    );

  if (script) {
    say("Removing the Worker and its data");
    await cloudflare.run(Workers.deleteScript({ accountId, scriptName: name.script, force: true }));
  }

  const { apps, buckets, kept } = await removable(target);

  if (apps.length > 0) say("Removing the Access apps");

  for (const app of apps) if (app.id) await cloudflare.run(ZeroTrust.deleteAccessApplicationForAccount({ accountId, appId: app.id }));

  for (const bucketName of buckets) {
    say(`Emptying and removing the bucket ${bucketName}`);

    const keys = (await cloudflare.list(R2.listObjects.items({ accountId, bucketName, perPage: 1000 }))).flatMap((object) =>
      object.key ? [object.key] : []
    );

    for (let i = 0; i < keys.length; i += 1000) await cloudflare.run(R2.deleteObjects({ accountId, bucketName, body: keys.slice(i, i + 1000) }));
    await cloudflare.run(R2.deleteBucket({ accountId, bucketName }));
  }

  for (const left of kept) say(`Leaving ${left}`);
}

/** What teardown should have removed that's still in the account. */
export async function leftovers(target: Target): Promise<string[]> {
  const name = names(target.config);
  const worker = await existing(target.cloudflare, name.account, name.script);
  const { apps, buckets } = await removable(target);

  return [
    ...(worker ? [`Worker ${name.script}`] : []),
    ...buckets.map((bucket) => `Bucket ${bucket}`),
    ...apps.map((app) => `Access app ${app.name}`)
  ];
}
