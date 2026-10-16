/**
 * Deploys a release to the user's account, checks what's there, and removes it, with direct
 * Cloudflare API calls. What to deploy is the release's generic wrangler.jsonc with the user's
 * overlay merged over it (C6); everything else is found again each run, so nothing is kept between
 * runs.
 *
 * ky changes and removes only what it made. A Worker the CLI deployed carries the `ky` tag and its
 * release's version; one of the same name without the tag (one `pnpm run deploy` made, say) is
 * never changed or removed. A bucket the CLI made holds a marker object; one without it is never
 * adopted or emptied, and teardown leaves a bucket another Worker binds. An Access app the CLI
 * made carries the `ky` tag too; one without it that guards the Worker's address is never changed
 * or removed.
 */
import { createHash } from "node:crypto";
import { extname } from "node:path";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as EmailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as R2 from "@distilled.cloud/cloudflare/r2";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as ZeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Zones from "@distilled.cloud/cloudflare/zones";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Unstable_RawConfig } from "wrangler";
import { answeredWithError, type Cloudflare, getService, refused, SCOPES, tokenPage } from "./cloudflare.ts";
import { emails, mailAddress, writeDeployed } from "./config.ts";
import { BYPASS } from "../src/access.ts";
import { copyImage, imageDigest, TARGET } from "./image.ts";
import { type Release, releaseImage } from "./release.ts";

/** The tag every Worker and Access app the CLI makes carries, and the one that names a Worker's release. */
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
  "ratelimits",
  "migrations",
  "observability",
  "vars",
  "vpc_services",
  "send_email"
]);

/** Why a key wrangler.jsonc may hold isn't deployed here. */
const REFUSED = new Map([["containers", "the deployer attaches the cloud machine's container itself, on an account with Workers Paid"]]);

/** The Durable Object class the cloud machine's container backs. */
const CLOUD_CLASS = "CloudMachine";

/** The repository in the account's registry the cloud machine's image is copied to. */
const CLOUD_REPOSITORY = "ky-cloud";

/** The cloud machine's size: half a vCPU, 4 GiB and 8 GB of disk. */
const CLOUD_INSTANCE = "standard-1";

/** Where the user moves the account to Workers Paid. */
function plansPage(accountId: string): string {
  return `https://dash.cloudflare.com/${accountId}/workers/plans`;
}

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
};

/** One piece `ky doctor` checks, and what fixes it. */
export type Check = { name: string; ok: boolean; detail: string; next?: string };

type Script = Awaited<ReturnType<typeof scripts>>[number];

type Names = ReturnType<typeof names>;

/** A Worker, bucket or Access app of this deploy's that ky didn't make. */
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

/** What R2 takes as a bucket's name. */
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The bucket for a binding, the Worker's name and the binding's, refused when R2 wouldn't take it. */
function bucketFor(script: string, binding: string): string {
  const bucketName = `${script}-${binding.toLowerCase().replaceAll("_", "-")}`;

  if (!BUCKET.test(bucketName))
    throw new Error(`The ${binding} binding's bucket would be ${bucketName}, and R2 takes only 3 to 63 lowercase letters, digits and dashes: pick a shorter name`);

  return bucketName;
}

/** The names this deploy's resources go by: each bucket is the Worker's name and its binding's. */
function names(config: Unstable_RawConfig) {
  const script = required(config.name, "name");

  return {
    account: required(config.account_id, "account_id"),
    script,
    access: script,
    bypass: `${script} bypass`,
    buckets: (config.r2_buckets ?? []).map((bucket) => ({ binding: bucket.binding, name: bucketFor(script, bucket.binding) })),
    cloud: `${script}-cloud`
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
 * The deploy's Worker, when there is one, and its address, once none of the Worker, the buckets of
 * the deploy's names and the Access apps that guard the address is one ky didn't make; it writes
 * nothing.
 */
export async function claim(target: Target) {
  const { cloudflare, settings } = target;
  const name = names(target.config);
  const script = await findScript(target, name);

  for (const bucket of name.buckets)
    if ((await bucketState(cloudflare, name.account, bucket.name)) === "theirs")
      throw new NameTaken(`A bucket named ${bucket.name} is already in this account and ky didn't create it`, settings);
  const address = await host(cloudflare, name.account, name.script);
  const [theirs] = (await accessFor(cloudflare, name.account, address)).theirs;

  if (theirs) throw new NameTaken(theirApp(theirs, address), settings);

  return { script, address };
}

async function host(cloudflare: Cloudflare, accountId: string, name: string): Promise<string> {
  const subdomain = await cloudflare.find(Workers.getSubdomain({ accountId }), "SubdomainNotFound");

  if (!subdomain?.subdomain) throw new Error("This account has no workers.dev subdomain yet: run `ky init --subdomain <name>`");

  return `${name}.${subdomain.subdomain}.workers.dev`;
}

/** The address the deployed ky answers on, `https://<worker>.<subdomain>.workers.dev`. */
export async function address(target: Target): Promise<string> {
  const name = names(target.config);

  return `https://${await host(target.cloudflare, name.account, name.script)}`;
}

/** The account's Access team domain, `<team>.cloudflareaccess.com`; undefined until Zero Trust is on. */
export async function teamDomain(cloudflare: Cloudflare, accountId: string): Promise<string | undefined> {
  const organization = await cloudflare.find(ZeroTrust.listOrganizationsForAccount({ accountId }), "OrganizationNotFound");

  return organization?.authDomain ?? undefined;
}

/** What to do when the Worker ran a migration this release doesn't have. */
const NEWER = "get a newer ky: `git pull && pnpm compile` in your ky checkout";

/** Whether the Worker ran a migration this release doesn't have: it's newer than this ky. */
function newer(migrations: Migrations, applied: string | undefined): boolean {
  return applied !== undefined && !migrations.some((migration) => migration.tag === applied);
}

/** The config's migrations the Worker hasn't run, as one upload: all of them on the first deploy. */
function pendingMigrations(migrations: Migrations, applied: string | undefined) {
  if (newer(migrations, applied)) throw new Error(`The Worker ran migration ${applied}, which this release doesn't have: this ky is older than the Worker; ${NEWER}`);
  const from = applied ? migrations.findIndex((migration) => migration.tag === applied) : -1;
  const pending = migrations.slice(from + 1);

  if (pending.length === 0) return undefined;

  return {
    oldTag: applied,
    newTag: pending.at(-1)?.tag,
    steps: pending.map((migration) => ({
      newSqliteClasses: migration.new_sqlite_classes,
      newClasses: migration.new_classes,
      deletedClasses: migration.deleted_classes,
      renamedClasses: migration.renamed_classes,
      transferredClasses: migration.transferred_classes?.map((moved) => ({ from: moved.from, fromScript: moved.from_script, to: moved.to }))
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
    ...(config.ratelimits ?? []).map(
      (limit): Binding => ({ type: "ratelimit", name: limit.name, namespaceId: limit.namespace_id, simple: limit.simple })
    ),
    ...(config.vpc_services ?? []).map((service): Binding => ({ type: "vpc_service", name: service.binding, serviceId: service.service_id })),
    ...(config.send_email ?? []).map(
      (email): Binding => ({
        type: "send_email",
        name: email.name,
        destinationAddress: email.destination_address,
        allowedDestinationAddresses: email.allowed_destination_addresses,
        allowedSenderAddresses: email.allowed_sender_addresses
      })
    ),
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

/** The web app's manifest, path to hash, and its files by hash; as in wrangler's, a hash covers the file and its extension. */
function hashed(assets: Release["assets"]) {
  const files = new Map<string, File>();
  const manifest: Record<string, { hash: string; size: number }> = {};

  for (const [path, content] of assets) {
    const ext = extname(path).slice(1);
    const hash = createHash("sha256").update(content).update(ext).digest("hex").slice(0, 32);

    manifest[path] = { hash, size: content.byteLength };
    files.set(hash, new File([Buffer.from(content).toString("base64")], hash, { type: TYPES.get(ext.toLowerCase()) ?? "application/octet-stream" }));
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

function tagged(app: FoundApp): boolean {
  return ("tags" in app && app.tags?.includes(TAG)) ?? false;
}

function theirApp(app: FoundApp, address: string): string {
  return `An Access app named ${app.name} already guards ${address} and ky didn't make it`;
}

/**
 * The Access apps that guard this address or a C2 path under it: of ky's, the owner's covers the
 * address and the bypass app the paths; `theirs` are the ones ky didn't make.
 */
async function accessFor(cloudflare: Cloudflare, accountId: string, address: string) {
  const paths = BYPASS.map((path) => normal(`${address}${path}`));
  const guarding = (await accessApps(cloudflare, accountId)).filter((app) => [normal(address), ...paths].some((uri) => guards(app).has(uri)));
  const ours = guarding.filter(tagged);
  const owner = ours.find((app) => guards(app).has(normal(address)));

  return {
    owner,
    bypass: ours.find((app) => app !== owner && paths.some((path) => guards(app).has(path))),
    theirs: guarding.filter((app) => !tagged(app)),
    paths
  };
}

/** The account's `ky` Access tag, which an app must have before it's tagged. */
async function ensureTag(cloudflare: Cloudflare, accountId: string): Promise<void> {
  if ((await cloudflare.list(ZeroTrust.listAccessTags.items({ accountId }))).some((tag) => tag.name === TAG)) return;
  await cloudflare.run(ZeroTrust.createAccessTag({ accountId, name: TAG }));
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

  await ensureTag(cloudflare, accountId);

  const aud = await saveApp(cloudflare, found.owner, {
    accountId,
    type: "self_hosted",
    name: name.access,
    tags: [TAG],
    destinations: [{ type: "public", uri: address }],
    policies: [{ name: "owner", decision: "allow", include: allowed.map((email) => ({ email: { email } })) }]
  });

  await saveApp(cloudflare, found.bypass, {
    accountId,
    type: "self_hosted",
    name: name.bypass,
    tags: [TAG],
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

/** Whether the account runs containers: Workers Paid, and a login that may use them. */
async function runsContainers(cloudflare: Cloudflare, accountId: string): Promise<boolean> {
  try {
    await cloudflare.run(Containers.getContainerIdentity({ accountId }));

    return true;
  } catch (error) {
    if (!answeredWithError(error)) throw error;

    return false;
  }
}

/** Whether the cloud machine deploys: the release has its image, and the account runs containers. */
async function cloudState(cloudflare: Cloudflare, accountId: string, release: Release): Promise<{ image: string } | { off: string }> {
  const none = { off: "this ky's release has no cloud machine image" };

  if (!release.image && !release.imageFrom) return none;

  if (!(await runsContainers(cloudflare, accountId)))
    return { off: `this account can't run containers: it needs Workers Paid (${plansPage(accountId)}), and a login with Containers: Edit` };
  const image = await releaseImage(release);

  return image ? { image } : none;
}

/** The cloud machine's Durable Object namespace, once the Worker has run migration v3. */
async function cloudNamespace(cloudflare: Cloudflare, name: Names): Promise<string | undefined> {
  const namespaces = await cloudflare.list(DurableObjects.listNamespaces.items({ accountId: name.account }));

  return namespaces.find((namespace) => namespace.script === name.script && namespace.class === CLOUD_CLASS)?.id ?? undefined;
}

/** The container app that backs the Worker's cloud machine; undefined when there's none, or the account runs no containers. */
async function cloudApp(cloudflare: Cloudflare, name: Names) {
  if (!(await runsContainers(cloudflare, name.account))) return undefined;
  const namespaceId = await cloudNamespace(cloudflare, name);

  if (!namespaceId) return undefined;

  return (await cloudflare.run(Containers.listContainerApplications({ accountId: name.account }))).find((app) => app.durableObjects?.namespaceId === namespaceId);
}

/** A short-lived login to the account's registry, to push the image with. */
async function registryLogin(cloudflare: Cloudflare, accountId: string) {
  const credential = await cloudflare.run(
    Containers.createContainerRegistryCredentials({ accountId, registryId: TARGET, permissions: ["pull", "push"], expirationMinutes: 15 })
  );

  const username = credential.username ?? credential.user;

  if (!username) throw new Error("Cloudflare returned no registry login");

  return { username, password: credential.password };
}

/**
 * How many containers the app may run: one per sandbox (SANDBOX_CAP in src/sandboxes.ts), and one
 * more for a sandbox that wakes while its last container still saves its disk.
 */
const CLOUD_MAX_INSTANCES = 9;

/**
 * Attaches the image to the cloud machine's namespace: a new container app, or a rollout of the one
 * there; an app from before sandboxes gets room for them.
 */
async function ensureCloudApp(cloudflare: Cloudflare, name: Names, image: string, say: (step: string) => void): Promise<void> {
  const accountId = name.account;
  const namespaceId = await cloudNamespace(cloudflare, name);

  if (!namespaceId) throw new Error(`Cloudflare made no ${CLOUD_CLASS} namespace for ${name.script}`);
  const configuration = { image, instanceType: CLOUD_INSTANCE };
  const app = (await cloudflare.run(Containers.listContainerApplications({ accountId }))).find((each) => each.durableObjects?.namespaceId === namespaceId);

  if (!app) {
    say("Setting up the cloud machine");
    await cloudflare.run(
      Containers.createContainerApplication({
        accountId,
        name: name.cloud,
        // Each sandbox starts when a task wakes it.
        maxInstances: CLOUD_MAX_INSTANCES,
        instances: 0,
        schedulingPolicy: "default",
        constraints: {},
        configuration,
        durableObjects: { namespaceId }
      })
    );

    return;
  }

  // Only ever raised: a higher limit the user set stays.
  if (app.maxInstances < CLOUD_MAX_INSTANCES) {
    say("Making room for the sandboxes");
    await cloudflare.run(Containers.updateContainerApplication({ accountId, applicationId: app.id, maxInstances: CLOUD_MAX_INSTANCES }));
  }

  if (app.configuration.image === image) return;
  say("Rolling out the cloud machine's new image");
  await cloudflare.run(Containers.updateContainerApplication({ accountId, applicationId: app.id, configuration }));
  await cloudflare.run(
    Containers.createContainerApplicationRollout({
      accountId,
      applicationId: app.id,
      description: "ky deploy",
      strategy: "rolling",
      kind: "full_auto",
      stepPercentage: 100,
      targetConfiguration: configuration
    })
  );
}

/** What a login needs, past a deploy's, to route ky's mail. */
const MAIL_SCOPES = "Zone: Read and Email Routing Rules: Edit";

/** Where the user turns Email Routing on for a domain. */
const emailRoutingPage = (accountId: string, domain: string) => `https://dash.cloudflare.com/${accountId}/${domain}/email/routing/overview`;

/** Whether `rule` takes mail to `address`, and nothing else. */
const takes = (rule: EmailRouting.GetRuleResponse, address: string) =>
  rule.matchers?.length === 1 && rule.matchers[0]?.type === "literal" && rule.matchers[0].value?.toLowerCase() === address;

/** Whether `rule` hands its mail to the Worker `script`. */
const handsTo = (rule: EmailRouting.GetRuleResponse, script: string) => rule.actions?.some((action) => action.type === "worker" && action.value?.includes(script)) === true;

/**
 * The Email Routing rule that hands mail to ky's address to this Worker: made when it's missing. The address's
 * domain is a zone of the account with Email Routing on; a rule that sends the address elsewhere is the user's, and refused.
 */
async function ensureMailRoute(cloudflare: Cloudflare, accountId: string, script: string, address: string): Promise<void> {
  const domain = address.split("@")[1] ?? "";

  try {
    const [zone] = await cloudflare.list(Zones.listZones.items({ name: domain, account: { id: accountId } }));

    if (!zone) throw new Error(`${domain}, ky's mail domain, isn't on this Cloudflare account: add it, then run \`ky deploy\``);
    const routing = await cloudflare.run(EmailRouting.getEmailRouting({ zoneId: zone.id }));

    if (!routing.enabled) throw new Error(`Email Routing is off for ${domain}: turn it on at ${emailRoutingPage(accountId, domain)}, then run \`ky deploy\``);
    const rules = await cloudflare.list(EmailRouting.listRules.items({ zoneId: zone.id }));
    const found = rules.find((rule) => takes(rule, address));

    if (found && handsTo(found, script)) return;

    if (found) throw new Error(`An Email Routing rule already sends ${address} elsewhere: point it at the Worker ${script} at ${emailRoutingPage(accountId, domain)}, or pick another address`);

    await cloudflare.run(
      EmailRouting.createRule({
        zoneId: zone.id,
        name: `ky: ${script}`,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: address }],
        actions: [{ type: "worker", value: [script] }]
      })
    );
  } catch (error) {
    if (refused(error)) throw new Error(`Routing ${address} to ky needs a token with ${MAIL_SCOPES} too: add them at ${tokenPage()}, then run \`ky login\``);
    throw error;
  }
}

/**
 * Deploys the release: buckets, the Access apps, the web app, then the Worker with its bindings,
 * the migrations it hasn't run and `ACCESS_*`; then workers.dev.
 */
export async function deploy(target: Target, release: Release, say: (step: string) => void): Promise<Deployed> {
  const { cloudflare, config } = target;
  const name = names(config);
  const accountId = name.account;
  const allowed = emails(config);
  const team = await teamDomain(cloudflare, accountId);

  if (!team) throw new Error(`Zero Trust isn't on for this account: turn it on at ${zeroTrustPage(accountId)} (the free plan is enough), then run \`ky deploy\``);
  const { script, address } = await claim(target);
  const applied = script && (await migrationTag(cloudflare, accountId, name.script));
  const cloud = await cloudState(cloudflare, accountId, release);
  let image: string | undefined;

  if ("image" in cloud) {
    say("Copying the cloud machine's image");
    image = await copyImage({ source: cloud.image, account: accountId, repository: CLOUD_REPOSITORY, login: await registryLogin(cloudflare, accountId) });
  } else say(`Skipping the cloud machine: ${cloud.off}`);

  say("Setting up the bucket");
  await ensureBuckets(cloudflare, name);
  say("Setting up Access");
  const aud = await ensureAccess(cloudflare, name, address, allowed);

  say("Uploading the web app");
  const jwt = await uploadAssets(cloudflare, accountId, name.script, release.assets);

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
        bindings: bindings(config, name.buckets, {
          ACCESS_TEAM_DOMAIN: team,
          ACCESS_AUD: aud,
          ACCESS_EMAILS: allowed.join(","),
          ...(image && { KY_CLOUD: "1" })
        }),
        containers: image ? [{ className: CLOUD_CLASS }] : undefined,
        keepBindings: ["secret_text"],
        migrations: pendingMigrations(config.migrations ?? [], applied),
        observability: config.observability ? { enabled: config.observability.enabled ?? false } : undefined,
        tags: [TAG, `${RELEASE_TAG}${release.version}`]
      },
      files: [...release.modules].map(([module, content]) => new File([Buffer.from(content)], module, { type: "application/javascript+module" }))
    })
  );

  if (image) await ensureCloudApp(cloudflare, name, image, say);

  say("Turning on workers.dev");
  await cloudflare.run(Workers.createScriptSubdomain({ accountId, scriptName: name.script, enabled: true, previewsEnabled: false }));

  const mail = mailAddress(config);

  if (mail) {
    say(`Routing ${mail} to ky`);
    await ensureMailRoute(cloudflare, accountId, name.script, mail);
  }

  // So ky backup and ky restore find it with no Cloudflare login, only cloudflared's.
  await writeDeployed(target.settings, { account: accountId, name: name.script, url: `https://${address}` });

  return { url: `https://${address}`, from: script ? (releaseOf(script) ?? "an unknown release") : undefined };
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

  const address = `${name.script}.${subdomain}.workers.dev`;
  const access = await accessFor(cloudflare, accountId, address);

  for (const each of await ownershipChecks(target, access, address)) check(each);

  if (!script) {
    check({ name: "Worker", ok: false, detail: `no Worker named ${name.script}`, next: "ky deploy" });

    return;
  }

  check({ name: "Worker", ok: true, detail: name.script });
  await inspectWorker(target, release, script, access, address, check);
}

type Access = Awaited<ReturnType<typeof accessFor>>;

/** The deploy's buckets, and any Access app on its address ky didn't make. */
async function ownershipChecks({ cloudflare, config, settings }: Target, access: Access, address: string): Promise<Check[]> {
  const name = names(config);
  const buckets: Check[] = [];

  for (const bucket of name.buckets) buckets.push(bucketCheck(await bucketState(cloudflare, name.account, bucket.name), bucket.name, settings));

  return [...buckets, ...access.theirs.map((app): Check => ({ name: "Access", ok: false, detail: theirApp(app, address), next: rename(settings) }))];
}

/** The Worker's release, migrations, Access apps and workers.dev. */
async function inspectWorker(target: Target, release: Release, script: Script, access: Access, address: string, check: Checker): Promise<void> {
  const { cloudflare, config } = target;
  const name = names(config);
  const accountId = name.account;

  for (const each of releaseChecks(releaseOf(script), release, await migrationTag(cloudflare, accountId, name.script))) check(each);

  for (const each of accessChecks(access, address)) check(each);
  const workersDev = await cloudflare.run(Workers.getScriptSubdomain({ accountId, scriptName: name.script }));

  check({ name: "workers.dev", ok: workersDev.enabled, detail: workersDev.enabled ? `https://${address}` : "off", next: "ky deploy" });
  check(await cloudCheck(cloudflare, name, release));
}

/** Whether the cloud machine runs this release's image; on an account without containers, why it's off, which is fine. */
async function cloudCheck(cloudflare: Cloudflare, name: Names, release: Release): Promise<Check> {
  const cloud = await cloudState(cloudflare, name.account, release);

  if (!("image" in cloud)) return { name: "Cloud machine", ok: true, detail: `off, so tasks run on your computers: ${cloud.off}` };
  const app = await cloudApp(cloudflare, name);

  if (!app) return { name: "Cloud machine", ok: false, detail: "no container app", next: "ky deploy" };

  // The release names an image (or an index of them); the account's copy goes by its linux/amd64 manifest.
  if (!app.configuration.image.endsWith(`@${await imageDigest(cloud.image)}`))
    return { name: "Cloud machine", ok: false, detail: `runs ${app.configuration.image}, not this ky's ${cloud.image}`, next: "ky deploy" };

  return { name: "Cloud machine", ok: true, detail: name.cloud };
}

/** Whether the Worker runs this ky's release and its migrations; a Worker past them is newer than this ky. */
function releaseChecks(deployed: string | undefined, release: Release, applied: string | undefined): Check[] {
  const migrations = release.config.migrations ?? [];
  const latest = migrations.at(-1)?.tag;

  if (newer(migrations, applied))
    return [{ name: "Release", ok: false, detail: `${deployed ?? "unknown"} ran migration ${applied}: this ky (${release.version}) is older than the Worker`, next: NEWER }];

  return [
    {
      name: "Release",
      ok: deployed === release.version,
      detail: deployed === release.version ? release.version : `${deployed ?? "unknown"}, this ky is ${release.version}`,
      next: "ky upgrade"
    },
    { name: "Migrations", ok: applied === latest, detail: `${applied ?? "none"}${applied === latest ? "" : `, this release has ${latest}`}`, next: "ky deploy" }
  ];
}

/** Whether an Access app guards the address, and whether the bypass app covers every C2 path under it. */
function accessChecks(access: Access, address: string): Check[] {
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

/** ky's Access apps on the Worker's address, and the others there; undefined without a workers.dev subdomain to find them by. */
async function appsAt(cloudflare: Cloudflare, name: Names) {
  const subdomain = (await cloudflare.find(Workers.getSubdomain({ accountId: name.account }), "SubdomainNotFound"))?.subdomain;

  if (!subdomain) return undefined;
  const access = await accessFor(cloudflare, name.account, `${name.script}.${subdomain}.workers.dev`);

  return {
    apps: [access.owner, access.bypass].flatMap((app) => (app ? [app] : [])),
    kept: access.theirs.map((app) => `the Access app ${app.name}: ky didn't make it`)
  };
}

/**
 * What teardown removes once the Worker is gone (ky's Access apps for its address, the buckets ky
 * made that no other Worker binds), what it leaves, and whether the Access apps couldn't be found.
 */
async function removable({ cloudflare, config }: Target) {
  const name = names(config);
  const access = await appsAt(cloudflare, name);
  const buckets: string[] = [];
  const kept: string[] = [];

  for (const bucket of name.buckets) {
    const fate = await bucketFate(cloudflare, name.account, bucket.name, name.script);

    if (fate === "remove") buckets.push(bucket.name);
    else if (fate !== "gone") kept.push(`the bucket ${bucket.name}: ${fate.leave}`);
  }

  return { apps: access?.apps ?? [], buckets, kept: [...kept, ...(access?.kept ?? [])], lost: !access };
}

/**
 * Removes the Worker (its Durable Objects' data and secrets go with it), then its Access apps and
 * buckets; when the Access apps can't be found, it says so and the overlay stays.
 */
export async function teardown(target: Target, say: (step: string) => void): Promise<void> {
  const { cloudflare, config, settings } = target;
  const name = names(config);
  const accountId = name.account;
  const script = await existing(cloudflare, accountId, name.script);

  if (script && !ours(script))
    throw new Error(
      `A Worker named ${name.script} is in this account and ky didn't deploy it, so ky teardown leaves it alone, with its Access apps and buckets; delete ${settings} to forget these settings`
    );

  // The container app first: it holds on to the Worker's namespace.
  const app = script && (await cloudApp(cloudflare, name));

  if (app) {
    say("Removing the cloud machine");
    await cloudflare.find(Containers.deleteContainerApplication({ accountId, applicationId: app.id }), "ContainerApplicationNotFound");
  }

  if (script) {
    say("Removing the Worker and its data");
    await cloudflare.run(Workers.deleteScript({ accountId, scriptName: name.script, force: true }));
  }

  const { apps, buckets, kept, lost } = await removable(target);

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

  if (lost)
    throw new Error(
      `This account has no workers.dev subdomain, so ky can't find the Access apps that guarded ${name.script}: remove them at ${zeroTrustPage(accountId)}, then delete ${settings}`
    );
}

/** What teardown should have removed that's still in the account. */
export async function leftovers(target: Target): Promise<string[]> {
  const name = names(target.config);
  const worker = await existing(target.cloudflare, name.account, name.script);
  const { apps, buckets } = await removable(target);

  const containers = (await runsContainers(target.cloudflare, name.account))
    ? (await target.cloudflare.run(Containers.listContainerApplications({ accountId: name.account }))).filter((app) => app.name === name.cloud)
    : [];

  return [
    ...(worker ? [`Worker ${name.script}`] : []),
    ...containers.map((app) => `Container app ${app.name}`),
    ...buckets.map((bucket) => `Bucket ${bucket}`),
    ...apps.map((app) => `Access app ${app.name}`)
  ];
}
