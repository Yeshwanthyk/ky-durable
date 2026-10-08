/**
 * Deploys a release to the user's account, checks what's there, and removes it, with direct
 * Cloudflare API calls. What to deploy is the release's generic wrangler.jsonc with the user's
 * overlay merged over it (C6); everything else is found by name, so nothing is kept between runs.
 *
 * A Worker the CLI deployed carries the `ky` tag and its release's version. A Worker of the same
 * name without the tag (one `pnpm run deploy` made, say) is never changed or removed.
 */
import { createHash, randomBytes } from "node:crypto";
import * as R2 from "@distilled.cloud/cloudflare/r2";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as ZeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Unstable_RawConfig } from "wrangler";
import type { Cloudflare } from "./cloudflare.ts";
import type { Release } from "./release.ts";

/** C2: what Access lets through without a login; each of these checks its own bearer, or is public. */
export const BYPASS = ["/runner/*", "/api/runners/pair", "/api/files", "/manifest.webmanifest", "/icons/*"];

/** The tag every Worker the CLI deploys carries, and the one that names its release. */
const TAG = "ky";

const RELEASE_TAG = "ky-release-";

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
  ["routes", "a custom domain deploys with `pnpm run deploy` from a checkout"],
  // CM: the cloud machine's Container app deploys here, after the script, from its namespace, and
  // teardown removes it before the Worker.
  ["containers", "Container apps arrive with the cloud machine"]
]);

type Binding = Workers.PutScriptBinding;

type Migrations = NonNullable<Unstable_RawConfig["migrations"]>;

type AccessApp = Parameters<typeof ZeroTrust.createAccessApplicationForAccount>[0];

/** One deploy target: an account, and the config to deploy there. */
export type Target = { cloudflare: Cloudflare; config: Unstable_RawConfig };

export type Deployed = {
  url: string;
  /** The release the Worker ran before, or undefined when this deploy created it. */
  from?: string;
  /** KY_TOKEN, when this deploy set one; it's shown once and kept nowhere else. */
  token?: string;
};

/** One piece `ky doctor` checks, and the command that fixes it. */
export type Check = { name: string; ok: boolean; detail: string; next?: string };

type Script = Awaited<ReturnType<typeof scripts>>[number];

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === "") throw new Error(`The config has no ${what}; run \`ky init\``);

  return value;
}

/** The names this deploy's resources go by. */
function names(config: Unstable_RawConfig) {
  const script = required(config.name, "name");

  return {
    account: required(config.account_id, "account_id"),
    script,
    access: script,
    bypass: `${script} bypass`,
    buckets: (config.r2_buckets ?? []).map((bucket) => required(bucket.bucket_name, `bucket_name for ${bucket.binding}`))
  };
}

/** The release a Worker the CLI deployed runs, from its tags. */
function releaseOf(script: Script): string | undefined {
  return script.tags?.find((tag) => tag.startsWith(RELEASE_TAG))?.slice(RELEASE_TAG.length);
}

function scripts(cloudflare: Cloudflare, accountId: string) {
  return cloudflare.list(Workers.listScripts.items({ accountId }));
}

/** The Worker of this name, refusing one the CLI didn't deploy. */
async function findScript(cloudflare: Cloudflare, accountId: string, name: string): Promise<Script | undefined> {
  const script = (await scripts(cloudflare, accountId)).find((candidate) => candidate.id === name);

  if (script && !script.tags?.includes(TAG))
    throw new Error(`A Worker named ${name} is already in this account and ky didn't deploy it; pick another name`);

  return script;
}

async function host(cloudflare: Cloudflare, accountId: string, name: string): Promise<string> {
  const subdomain = await cloudflare.find(Workers.getSubdomain({ accountId }), "SubdomainNotFound");

  if (!subdomain?.subdomain) throw new Error("This account has no workers.dev subdomain yet; run `ky init`");

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

/** The Worker's bindings, from the config, with `env` added as plain text. */
function bindings(config: Unstable_RawConfig, env: Record<string, string>): Binding[] {
  for (const key of Object.keys(config))
    if (!DEPLOYS.has(key)) throw new Error(`ky deploy can't deploy \`${key}\`: ${REFUSED.get(key) ?? "use `pnpm run deploy` from a checkout"}`);

  const single = (binding: { binding?: string } | undefined) => (binding?.binding ? [binding.binding] : []);

  return [
    ...single(config.version_metadata).map((name): Binding => ({ type: "version_metadata", name })),
    ...single(config.ai).map((name): Binding => ({ type: "ai", name })),
    ...single(config.browser).map((name): Binding => ({ type: "browser", name })),
    ...single(config.assets).map((name): Binding => ({ type: "assets", name })),
    ...(config.worker_loaders ?? []).map((loader): Binding => ({ type: "worker_loader", name: loader.binding })),
    ...(config.r2_buckets ?? []).map((bucket): Binding => ({ type: "r2_bucket", name: bucket.binding, bucketName: required(bucket.bucket_name, `bucket_name for ${bucket.binding}`) })),
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

function accessApps(cloudflare: Cloudflare, accountId: string, name: string) {
  return cloudflare
    .list(ZeroTrust.listAccessApplicationsForAccount.items({ accountId }))
    .then((apps) => apps.filter((app) => app.name === name));
}

/** Creates or updates the Access app of this name, and returns its audience tag. */
async function ensureAccessApp(
  cloudflare: Cloudflare,
  accountId: string,
  name: string,
  destinations: NonNullable<AccessApp["destinations"]>,
  policies: NonNullable<AccessApp["policies"]>
): Promise<string> {
  const found = (await accessApps(cloudflare, accountId, name))[0]?.id;
  const app = { accountId, type: "self_hosted", name, destinations, policies };

  const saved = found
    ? await cloudflare.run(ZeroTrust.updateAccessApplicationForAccount({ ...app, appId: found }))
    : await cloudflare.run(ZeroTrust.createAccessApplicationForAccount(app));

  if (!("aud" in saved) || !saved.aud) throw new Error(`Cloudflare returned no audience tag for the Access app ${name}`);

  return saved.aud;
}

/** The Access app that lets only the owner in, and the one for C2's paths; returns the first's audience tag. */
async function ensureAccess(cloudflare: Cloudflare, name: ReturnType<typeof names>, address: string, allowed: string[]): Promise<string> {
  const aud = await ensureAccessApp(
    cloudflare,
    name.account,
    name.access,
    [{ type: "public", uri: address }],
    [{ name: "owner", decision: "allow", include: allowed.map((email) => ({ email: { email } })) }]
  );

  await ensureAccessApp(
    cloudflare,
    name.account,
    name.bypass,
    BYPASS.map((path) => ({ type: "public", uri: `${address}${path}` })),
    [{ name: "runners and files", decision: "bypass", include: [{ everyone: {} }] }]
  );

  return aud;
}

async function ensureBuckets(cloudflare: Cloudflare, accountId: string, buckets: string[]): Promise<void> {
  for (const bucketName of buckets)
    if (!(await cloudflare.find(R2.getBucket({ accountId, bucketName }), "NoSuchBucket")))
      await cloudflare.run(R2.createBucket({ accountId, name: bucketName }));
}

/** A new KY_TOKEN, unless the Worker (when there is one) has it: it signs the owner in until Access replaces it (node A). */
async function newToken(cloudflare: Cloudflare, accountId: string, scriptName: string | undefined): Promise<string | undefined> {
  const secrets = scriptName ? await cloudflare.list(Workers.listScriptSecrets.items({ accountId, scriptName })) : [];

  return secrets.some((secret) => secret.name === "KY_TOKEN") ? undefined : Buffer.from(randomBytes(24)).toString("base64url");
}

/** The emails Access lets in: ACCESS_EMAILS (C3). */
function emails(config: Unstable_RawConfig): string[] {
  const value = config.vars?.ACCESS_EMAILS;

  return Value.Check(Type.String(), value) ? value.split(",").map((email) => email.trim()).filter(Boolean) : [];
}

/**
 * Deploys the release: buckets, the Access apps, the web app, then the Worker with its bindings,
 * the migrations it hasn't run, `ACCESS_*`, and a KY_TOKEN when it has none; then workers.dev.
 */
export async function deploy({ cloudflare, config }: Target, release: Release, say: (step: string) => void): Promise<Deployed> {
  const name = names(config);
  const accountId = name.account;
  const allowed = emails(config);

  if (allowed.length === 0) throw new Error("The config has no ACCESS_EMAILS; run `ky init`");
  const address = await host(cloudflare, accountId, name.script);
  const team = await teamDomain(cloudflare, accountId);

  if (!team) throw new Error("Zero Trust isn't on for this account; run `ky init`");
  const script = await findScript(cloudflare, accountId, name.script);

  say("Setting up the bucket");
  await ensureBuckets(cloudflare, accountId, name.buckets);
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
          ...bindings(config, { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ACCESS_EMAILS: allowed.join(",") }),
          ...secret
        ],
        keepBindings: ["secret_text"],
        migrations: pendingMigrations(config.migrations ?? [], script?.migrationTag ?? undefined),
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
export async function deployedRelease({ cloudflare, config }: Target): Promise<string | undefined> {
  const name = names(config);
  const script = await findScript(cloudflare, name.account, name.script);

  return script && (releaseOf(script) ?? "an unknown release");
}

/** Every piece of a deploy, checked in order, each with the command that fixes it. */
export async function inspect({ cloudflare, config }: Target, release: Release): Promise<Check[]> {
  const name = names(config);
  const accountId = name.account;
  const checks: Check[] = [];
  const check = (check: Check) => checks.push(check) && check.ok;
  const team = await teamDomain(cloudflare, accountId);

  check({
    name: "Zero Trust",
    ok: Boolean(team),
    detail: team ?? "off",
    next: `turn it on at https://one.dash.cloudflare.com/${accountId}, then \`ky deploy\``
  });
  const subdomain = await cloudflare.find(Workers.getSubdomain({ accountId }), "SubdomainNotFound");

  check({ name: "workers.dev subdomain", ok: Boolean(subdomain?.subdomain), detail: subdomain?.subdomain ?? "none", next: "ky init" });

  if (!subdomain?.subdomain) return checks;
  const address = `${name.script}.${subdomain.subdomain}.workers.dev`;
  const script = await findScript(cloudflare, accountId, name.script);

  check({ name: "Worker", ok: Boolean(script), detail: script ? name.script : `no Worker named ${name.script}`, next: "ky deploy" });

  if (!script) return checks;
  const deployed = releaseOf(script);

  check({
    name: "Release",
    ok: deployed === release.version,
    detail: deployed === release.version ? release.version : `${deployed ?? "unknown"}, this ky is ${release.version}`,
    next: "ky upgrade"
  });
  const latest = config.migrations?.at(-1)?.tag;

  check({
    name: "Migrations",
    ok: script.migrationTag === latest,
    detail: `${script.migrationTag ?? "none"}${script.migrationTag === latest ? "" : `, this release has ${latest}`}`,
    next: "ky upgrade"
  });
  const secrets = await cloudflare.list(Workers.listScriptSecrets.items({ accountId, scriptName: name.script }));
  const hasToken = secrets.some((secret) => secret.name === "KY_TOKEN");

  check({ name: "KY_TOKEN", ok: hasToken, detail: hasToken ? "set" : "missing", next: "ky deploy" });

  for (const bucketName of name.buckets) {
    const bucket = await cloudflare.find(R2.getBucket({ accountId, bucketName }), "NoSuchBucket");

    check({ name: "Bucket", ok: Boolean(bucket), detail: bucket ? bucketName : `no bucket ${bucketName}`, next: "ky deploy" });
  }

  const covers = async (app: string, uris: string[], covered: string) => {
    const found = (await accessApps(cloudflare, accountId, app))[0];
    const destinations = (found && "destinations" in found ? found.destinations : undefined) ?? [];
    const has = new Set(destinations.map((destination) => ("uri" in destination ? destination.uri : undefined)));
    const missing = uris.filter((uri) => !has.has(uri));

    check({
      name: `Access app "${app}"`,
      ok: Boolean(found) && missing.length === 0,
      detail: !found ? "missing" : missing.length > 0 ? `doesn't cover ${missing.join(", ")}` : covered,
      next: "ky deploy"
    });
  };

  await covers(name.access, [address], address);
  await covers(
    name.bypass,
    BYPASS.map((path) => `${address}${path}`),
    `${BYPASS.length} paths`
  );
  const workersDev = await cloudflare.run(Workers.getScriptSubdomain({ accountId, scriptName: name.script }));

  check({ name: "workers.dev", ok: workersDev.enabled, detail: workersDev.enabled ? `https://${address}` : "off", next: "ky deploy" });

  return checks;
}

/** Removes the Access apps, the Worker (its Durable Objects' data and secrets go with it) and the buckets. */
export async function teardown({ cloudflare, config }: Target, say: (step: string) => void): Promise<void> {
  const name = names(config);
  const accountId = name.account;
  const script = await findScript(cloudflare, accountId, name.script);

  say("Removing the Access apps");

  for (const app of [...(await accessApps(cloudflare, accountId, name.access)), ...(await accessApps(cloudflare, accountId, name.bypass))])
    if (app.id) await cloudflare.run(ZeroTrust.deleteAccessApplicationForAccount({ accountId, appId: app.id }));

  if (script) {
    say("Removing the Worker and its data");
    await cloudflare.run(Workers.deleteScript({ accountId, scriptName: name.script, force: true }));
  }

  for (const bucketName of name.buckets) {
    if (!(await cloudflare.find(R2.getBucket({ accountId, bucketName }), "NoSuchBucket"))) continue;
    say(`Emptying and removing the bucket ${bucketName}`);

    const keys = (await cloudflare.list(R2.listObjects.items({ accountId, bucketName, perPage: 1000 }))).flatMap((object) =>
      object.key ? [object.key] : []
    );

    for (let i = 0; i < keys.length; i += 1000) await cloudflare.run(R2.deleteObjects({ accountId, bucketName, body: keys.slice(i, i + 1000) }));
    await cloudflare.run(R2.deleteBucket({ accountId, bucketName }));
  }
}

/** What of a deploy is still in the account, by name. */
export async function leftovers({ cloudflare, config }: Target): Promise<string[]> {
  const name = names(config);
  const accountId = name.account;
  const worker = (await scripts(cloudflare, accountId)).some((script) => script.id === name.script);
  const buckets = (await cloudflare.run(R2.listBuckets({ accountId }))).buckets ?? [];
  const apps = [...(await accessApps(cloudflare, accountId, name.access)), ...(await accessApps(cloudflare, accountId, name.bypass))];

  return [
    ...(worker ? [`Worker ${name.script}`] : []),
    ...buckets.filter((bucket) => bucket.name && name.buckets.includes(bucket.name)).map((bucket) => `Bucket ${bucket.name}`),
    ...apps.map((app) => `Access app ${app.name}`)
  ];
}
