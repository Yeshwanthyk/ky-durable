/**
 * The deploy domain: deploys a release to the user's account, checks what's there, and removes it,
 * as Effects over @distilled.cloud/cloudflare's operations. What to deploy is the release's generic
 * wrangler.jsonc with the user's overlay merged over it (C6); everything else is found again each run,
 * so nothing is kept between runs. The edge that runs it is `Cloudflare.run` (cli/cloudflare.ts),
 * through wiring.ts.
 *
 * ky changes and removes only what it made. A Worker the CLI deployed carries the `ky` tag and its
 * release's version; one of the same name without the tag (one `pnpm run deploy` made, say) is
 * never changed or removed. A bucket the CLI made holds a marker object; one without it is never
 * emptied, and adopted only when it's empty and no other Worker binds it: the bucket a deploy cut
 * short made (I-D3). An Access app the CLI made carries the `ky` tag too; one without it that guards
 * the Worker's address is never changed or removed.
 *
 * Every write is read first and skipped when what's there is already what it would write, so a
 * second deploy of the same release makes reads only (I-D2).
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Unstable_RawConfig } from "wrangler";
import { BYPASS } from "../../src/access.ts";
import { getService, type Login, MAIL_SCOPES, SCOPES, type Services, tokenPage } from "../cloudflare.ts";
import { emails, mailAddress, writeDeployed } from "../config.ts";
import { copyImage, imageDigest, TARGET } from "../image.ts";
import { type Release, releaseImage, runs } from "../release.ts";
import {
  AppsLost,
  BucketName,
  CantDeployKey,
  type Check,
  type Deployed,
  type DeployRefusal,
  MailDomainMissing,
  MailRoutingOff,
  MailRuleElsewhere,
  MailScopes,
  MARKER,
  NEWER,
  NoAudience,
  NoCloudNamespace,
  NoConfig,
  NoRegistryLogin,
  NoSubdomain,
  NotOurWorker,
  OlderThanWorker,
  RELEASE_TAG,
  rename,
  TAG,
  Taken,
  ZeroTrustOff,
  zeroTrustPage
} from "./contract.ts";

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

/** The Durable Object class the cloud machine's container backs. */
const CLOUD_CLASS = "CloudMachine";

/** The repository in the account's registry the cloud machine's image is copied to. */
const CLOUD_REPOSITORY = "ky-cloud";

/** The cloud machine's size: half a vCPU, 4 GiB and 8 GB of disk. */
const CLOUD_INSTANCE = "standard-1";

/**
 * How many containers the app may run: one per sandbox (SANDBOX_CAP in src/sandboxes.ts), and one
 * more for a sandbox that wakes while its last container still saves its disk.
 */
const CLOUD_MAX_INSTANCES = 9;

/** Cloudflare's answer to a login whose token can't do this. */
const REFUSALS = new Set(["Forbidden", "Unauthorized"]);

/** A version that names a commit: a build from a dirty checkout goes by the same one, so its code is never taken as deployed. */
const COMMIT = /^[0-9a-f]{7,}$/;

/** Where the user moves the account to Workers Paid. */
function plansPage(accountId: string): string {
  return `https://dash.cloudflare.com/${accountId}/workers/plans`;
}

/** What Cloudflare fails with: a tagged error. */
interface Failure {
  readonly _tag: string;
}

/** One of the domain's actions: it needs distilled's login, and fails with a refusal or Cloudflare's error. */
type Op<A> = Effect.Effect<A, DeployRefusal | Failure, Services>;

type Say = (step: string) => void;

/** One deploy's settings: the config to deploy and the overlay file it came from. */
export type Site = { readonly config: Unstable_RawConfig; readonly settings: string };

type Binding = Workers.PutScriptBinding;

type Migrations = NonNullable<Unstable_RawConfig["migrations"]>;

type AccessApp = Parameters<typeof ZeroTrust.createAccessApplicationForAccount>[0];

type Out<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

type Script = Out<ReturnType<typeof scripts>>[number];

type FoundApp = Out<ReturnType<typeof accessApps>>[number];

type Names = Out<ReturnType<typeof names>>;

/** Every item of a paginated operation. */
const list = <A, E, R>(items: Stream.Stream<A, E, R>) => Stream.runCollect(items).pipe(Effect.map((all) => [...all]));

/** The operation's result, or undefined when it fails with one of `missing` (say `NoSuchBucket`). */
const find = <A, E extends Failure, R>(operation: Effect.Effect<A, E, R>, ...missing: string[]) =>
  operation.pipe(
    Effect.catchIf(
      (error: E) => missing.includes(error._tag),
      () => Effect.succeed(undefined)
    )
  );

/** Whether Cloudflare refused the login. */
const refused = (error: Failure) => REFUSALS.has(error._tag);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `found` holds everything `wanted` says: each field it sets, lists the same length, extra fields in `found` ignored. */
function covers(found: unknown, wanted: unknown): boolean {
  if (wanted === undefined) return true;

  if (Array.isArray(wanted)) return Array.isArray(found) && found.length === wanted.length && wanted.every((each, index) => covers(found[index], each));

  if (isRecord(wanted)) return isRecord(found) && Object.entries(wanted).every(([key, each]) => covers(found[key], each));

  return found === wanted;
}

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function required<T>(value: T | undefined, what: string): Effect.Effect<T, NoConfig> {
  return value === undefined || value === "" ? Effect.fail(new NoConfig({ what })) : Effect.succeed(value);
}

/** What R2 takes as a bucket's name. */
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The bucket for a binding, the Worker's name and the binding's, refused when R2 wouldn't take it. */
function bucketFor(script: string, binding: string): Effect.Effect<{ binding: string; name: string }, BucketName> {
  const bucketName = `${script}-${binding.toLowerCase().replaceAll("_", "-")}`;

  return BUCKET.test(bucketName) ? Effect.succeed({ binding, name: bucketName }) : Effect.fail(new BucketName({ binding, bucketName }));
}

/** The names this deploy's resources go by: each bucket is the Worker's name and its binding's. */
const names = (config: Unstable_RawConfig) =>
  Effect.gen(function* () {
    const script = yield* required(config.name, "name");
    const account = yield* required(config.account_id, "account_id");
    const buckets = yield* Effect.forEach(config.r2_buckets ?? [], (bucket) => bucketFor(script, bucket.binding));

    return { account, script, access: script, bypass: `${script} bypass`, buckets, cloud: `${script}-cloud` };
  });

/** The release a Worker the CLI deployed runs, from its tags. */
function releaseOf(script: Script): string | undefined {
  return script.tags?.find((tag) => tag.startsWith(RELEASE_TAG))?.slice(RELEASE_TAG.length);
}

function scripts(accountId: string) {
  return list(Workers.listScripts.items({ accountId }));
}

/** The Worker of this name, whoever deployed it. */
const existing = (accountId: string, name: string) => Effect.map(scripts(accountId), (all) => all.find((candidate) => candidate.id === name));

function ours(script: Script): boolean {
  return script.tags?.includes(TAG) ?? false;
}

/** The Worker of this name, refusing one the CLI didn't deploy. */
const findScript = (settings: string, name: Names) =>
  Effect.gen(function* () {
    const script = yield* existing(name.account, name.script);

    if (script && !ours(script)) return yield* new Taken({ taken: `A Worker named ${name.script} is already in this account and ky didn't deploy it`, settings });

    return script;
  });

/** The migration the Worker last ran, read where wrangler reads it. */
const migrationTag = (accountId: string, name: string) =>
  Effect.map(getService({ accountId, serviceName: name }), (service) => service.defaultEnvironment.script.migrationTag ?? undefined);

/** The other Workers that bind the bucket. */
const bindersOf = (accountId: string, bucketName: string, except: string) =>
  Effect.gen(function* () {
    const binders: string[] = [];

    for (const script of yield* scripts(accountId)) {
      if (!script.id || script.id === except) continue;
      const settings = yield* Workers.getScriptScriptAndVersionSetting({ accountId, scriptName: script.id });

      if (settings.bindings?.some((binding) => binding.type === "r2_bucket" && "bucketName" in binding && binding.bucketName === bucketName))
        binders.push(script.id);
    }

    return binders;
  });

/**
 * Whether the bucket is there, and whether the CLI made it: `orphan` is one without the marker that's
 * empty and that no Worker but `script` binds, as a deploy cut between making the bucket and marking it
 * leaves it; ky adopts it.
 */
const bucketState = (accountId: string, bucketName: string, script: string) =>
  Effect.gen(function* () {
    if (!(yield* find(R2.getBucket({ accountId, bucketName }), "NoSuchBucket"))) return "missing" as const;
    const marked = yield* list(R2.listObjects.items({ accountId, bucketName, prefix: MARKER }));

    if (marked.some((object) => object.key === MARKER)) return "ours" as const;
    const [first] = yield* list(Stream.take(R2.listObjects.items({ accountId, bucketName }), 1));

    if (first || (yield* bindersOf(accountId, bucketName, script)).length > 0) return "theirs" as const;

    return "orphan" as const;
  });

const host = (accountId: string, name: string) =>
  Effect.gen(function* () {
    const subdomain = yield* find(Workers.getSubdomain({ accountId }), "SubdomainNotFound");

    if (!subdomain?.subdomain) return yield* new NoSubdomain();

    return `${name}.${subdomain.subdomain}.workers.dev`;
  });

/** The account's Access team domain, `<team>.cloudflareaccess.com`; undefined until Zero Trust is on. */
const teamDomain = (accountId: string) =>
  Effect.map(find(ZeroTrust.listOrganizationsForAccount({ accountId }), "OrganizationNotFound"), (organization) => organization?.authDomain ?? undefined);

/** A destination as Access compares it: no scheme, no trailing slash, lower case. */
function normal(uri: string): string {
  return uri
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function accessApps(accountId: string) {
  return list(ZeroTrust.listAccessApplicationsForAccount.items({ accountId }));
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
const accessFor = (accountId: string, address: string) =>
  Effect.gen(function* () {
    const paths = BYPASS.map((path) => normal(`${address}${path}`));
    const guarding = (yield* accessApps(accountId)).filter((app) => [normal(address), ...paths].some((uri) => guards(app).has(uri)));
    const mine = guarding.filter(tagged);
    const owner = mine.find((app) => guards(app).has(normal(address)));

    return {
      owner,
      bypass: mine.find((app) => app !== owner && paths.some((path) => guards(app).has(path))),
      theirs: guarding.filter((app) => !tagged(app)),
      paths
    };
  });

type Access = Out<ReturnType<typeof accessFor>>;

/**
 * The deploy's Worker, when there is one, and its address, once none of the Worker, the buckets of
 * the deploy's names and the Access apps that guard the address is one ky didn't make; it writes
 * nothing.
 */
const claim = ({ config, settings }: Site) =>
  Effect.gen(function* () {
    const name = yield* names(config);
    const script = yield* findScript(settings, name);

    for (const bucket of name.buckets)
      if ((yield* bucketState(name.account, bucket.name, name.script)) === "theirs")
        return yield* new Taken({ taken: `A bucket named ${bucket.name} is already in this account and ky didn't create it`, settings });
    const address = yield* host(name.account, name.script);
    const [theirs] = (yield* accessFor(name.account, address)).theirs;

    if (theirs) return yield* new Taken({ taken: theirApp(theirs, address), settings });

    return { script, address };
  });

/** Whether the Worker ran a migration this release doesn't have: it's newer than this ky. */
function newer(migrations: Migrations, applied: string | undefined): boolean {
  return applied !== undefined && !migrations.some((migration) => migration.tag === applied);
}

/** The config's migrations the Worker hasn't run, as one upload: all of them on the first deploy. */
function pendingMigrations(migrations: Migrations, applied: string | undefined) {
  if (applied !== undefined && newer(migrations, applied)) return Effect.fail(new OlderThanWorker({ applied }));
  const from = applied ? migrations.findIndex((migration) => migration.tag === applied) : -1;
  const pending = migrations.slice(from + 1);

  if (pending.length === 0) return Effect.succeed(undefined);

  return Effect.succeed({
    oldTag: applied,
    newTag: pending.at(-1)?.tag,
    steps: pending.map((migration) => ({
      newSqliteClasses: migration.new_sqlite_classes,
      newClasses: migration.new_classes,
      deletedClasses: migration.deleted_classes,
      renamedClasses: migration.renamed_classes,
      transferredClasses: migration.transferred_classes?.map((moved) => ({ from: moved.from, fromScript: moved.from_script, to: moved.to }))
    }))
  });
}

/** The config's `send_email` bindings: ky's mail, sent from its own address. */
const sendEmail = (config: Unstable_RawConfig) =>
  (config.send_email ?? []).map(
    (email): Binding => ({
      type: "send_email",
      name: email.name,
      destinationAddress: email.destination_address,
      allowedDestinationAddresses: email.allowed_destination_addresses,
      allowedSenderAddresses: email.allowed_sender_addresses
    })
  );

/** The Worker's bindings, from the config, with its buckets and `env` added as plain text; a key the deployer doesn't deploy is refused. */
function bindings(config: Unstable_RawConfig, buckets: Names["buckets"], env: Record<string, string>): Binding[] | CantDeployKey {
  const key = Object.keys(config).find((each) => !DEPLOYS.has(each));

  if (key !== undefined) return new CantDeployKey({ key });

  const single = (binding: { binding?: string } | undefined) => (binding?.binding ? [binding.binding] : []);

  return [
    ...single(config.version_metadata).map((name): Binding => ({ type: "version_metadata", name })),
    ...single(config.ai).map((name): Binding => ({ type: "ai", name })),
    ...single(config.browser).map((name): Binding => ({ type: "browser", name })),
    ...single(config.assets).map((name): Binding => ({ type: "assets", name })),
    ...(config.worker_loaders ?? []).map((loader): Binding => ({ type: "worker_loader", name: loader.binding })),
    ...buckets.map((bucket): Binding => ({ type: "r2_bucket", name: bucket.binding, bucketName: bucket.name })),
    ...(config.durable_objects?.bindings ?? []).map((object): Binding => ({ type: "durable_object_namespace", name: object.name, className: object.class_name })),
    ...(config.ratelimits ?? []).map((limit): Binding => ({ type: "ratelimit", name: limit.name, namespaceId: limit.namespace_id, simple: limit.simple })),
    ...(config.vpc_services ?? []).map((service): Binding => ({ type: "vpc_service", name: service.binding, serviceId: service.service_id })),
    ...sendEmail(config),
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
const uploadAssets = (accountId: string, scriptName: string, assets: Release["assets"]) =>
  Effect.gen(function* () {
    const { manifest, files } = hashed(assets);
    const session = yield* Workers.createScriptAssetUpload({ accountId, scriptName, manifest });
    const jwtToken = session.jwt ?? "";
    let jwt = jwtToken;

    for (const bucket of session.buckets ?? []) {
      const body = Object.fromEntries(bucket.flatMap((hash) => files.get(hash) ?? []).map((file) => [file.name, file]));
      const uploaded = yield* Workers.createAssetUpload({ accountId, base64: true, body, jwtToken });

      jwt = uploaded.jwt ?? jwt;
    }

    return jwt;
  });

/** The account's `ky` Access tag, which an app must have before it's tagged. */
const ensureTag = (accountId: string) =>
  Effect.gen(function* () {
    if ((yield* list(ZeroTrust.listAccessTags.items({ accountId }))).some((tag) => tag.name === TAG)) return;
    yield* ZeroTrust.createAccessTag({ accountId, name: TAG });
  });

/** What an Access app is, as ky writes it: compared to see whether the found app is already that. */
function appShape(app: unknown) {
  return {
    name: field(app, "name"),
    type: field(app, "type"),
    tags: items(field(app, "tags")).map(String).sort(),
    destinations: items(field(app, "destinations")).map((destination) => ({ type: field(destination, "type"), uri: normal(String(field(destination, "uri") ?? "")) })),
    policies: items(field(app, "policies")).map((policy) => ({ name: field(policy, "name"), decision: field(policy, "decision"), include: field(policy, "include") }))
  };
}

/** The found app's audience tag when it's already `app`: nothing to write. */
function unchanged(found: FoundApp | undefined, app: AccessApp): string | undefined {
  const aud = found && "aud" in found ? found.aud : undefined;

  return aud && covers(appShape(found), appShape(app)) ? aud : undefined;
}

/** Creates the Access app, updates the one found, or leaves it when it's already `app`; returns its audience tag. */
const saveApp = (found: FoundApp | undefined, app: AccessApp) =>
  Effect.gen(function* () {
    const current = unchanged(found, app);

    if (current) return current;
    const saved = found?.id ? yield* ZeroTrust.updateAccessApplicationForAccount({ ...app, appId: found.id }) : yield* ZeroTrust.createAccessApplicationForAccount(app);

    if (!("aud" in saved) || !saved.aud) return yield* new NoAudience({ app: app.name ?? "" });

    return saved.aud;
  });

/** The Access app that lets only the owner in, and the one for C2's paths; returns the first's audience tag. */
const ensureAccess = (name: Names, address: string, allowed: string[]) =>
  Effect.gen(function* () {
    const accountId = name.account;
    const found = yield* accessFor(accountId, address);

    yield* ensureTag(accountId);

    const aud = yield* saveApp(found.owner, {
      accountId,
      type: "self_hosted",
      name: name.access,
      tags: [TAG],
      destinations: [{ type: "public", uri: address }],
      policies: [{ name: "owner", decision: "allow", include: allowed.map((email) => ({ email: { email } })) }]
    });

    yield* saveApp(found.bypass, {
      accountId,
      type: "self_hosted",
      name: name.bypass,
      tags: [TAG],
      destinations: BYPASS.map((path) => ({ type: "public", uri: `${address}${path}` })),
      policies: [{ name: "runners and files", decision: "bypass", include: [{ everyone: {} }] }]
    });

    return aud;
  });

/** Makes the buckets that aren't there yet, and marks them, and the one a cut deploy made, as ky's. */
const ensureBuckets = (name: Names) =>
  Effect.gen(function* () {
    const accountId = name.account;

    for (const bucket of name.buckets) {
      const state = yield* bucketState(accountId, bucket.name, name.script);

      if (state === "ours" || state === "theirs") continue;

      if (state === "missing") yield* R2.createBucket({ accountId, name: bucket.name });
      yield* R2.putObject({
        accountId,
        bucketName: bucket.name,
        objectName: MARKER,
        body: `ky made this bucket for the ${name.script} Worker; \`ky teardown\` removes it.`,
        contentType: "text/plain"
      });
    }
  });

/** Whether the account runs containers: Workers Paid, and a login that may use them. Any failure says no. */
const runsContainers = (accountId: string) => Effect.map(Effect.exit(Containers.getContainerIdentity({ accountId })), Exit.isSuccess);

/** Whether the cloud machine deploys: the release has its image, and the account runs containers. */
const cloudState = (accountId: string, release: Release) =>
  Effect.gen(function* () {
    const none = { off: "this ky's release has no cloud machine image" };

    if (!release.image && !release.imageFrom) return none;

    if (!(yield* runsContainers(accountId)))
      return { off: `this account can't run containers: it needs Workers Paid (${plansPage(accountId)}), and a login with Containers: Edit` };
    const image = yield* Effect.promise(() => releaseImage(release));

    return image ? { image } : none;
  });

/** The cloud machine's Durable Object namespace, once the Worker has run migration v3. */
const cloudNamespace = (name: Names) =>
  Effect.map(
    list(DurableObjects.listNamespaces.items({ accountId: name.account })),
    (namespaces) => namespaces.find((namespace) => namespace.script === name.script && namespace.class === CLOUD_CLASS)?.id ?? undefined
  );

/** The container app on a namespace, read by itself: the account's list can lag it, and name the image a finished rollout replaced. */
const namespaceApp = (accountId: string, namespaceId: string) =>
  Effect.gen(function* () {
    const listed = (yield* Containers.listContainerApplications({ accountId })).find((app) => app.durableObjects?.namespaceId === namespaceId);

    return listed && (yield* Containers.getContainerApplication({ accountId, applicationId: listed.id }));
  });

/** The container app that backs the Worker's cloud machine; undefined when there's none, or the account runs no containers. */
const cloudApp = (name: Names) =>
  Effect.gen(function* () {
    if (!(yield* runsContainers(name.account))) return undefined;
    const namespaceId = yield* cloudNamespace(name);

    if (!namespaceId) return undefined;

    return yield* namespaceApp(name.account, namespaceId);
  });

/** A short-lived login to the account's registry, to push the image with. */
const registryLogin = (accountId: string) =>
  Effect.gen(function* () {
    const credential = yield* Containers.createContainerRegistryCredentials({ accountId, registryId: TARGET, permissions: ["pull", "push"], expirationMinutes: 15 });
    const username = credential.username ?? credential.user;

    if (!username) return yield* new NoRegistryLogin();

    return { username, password: credential.password };
  });

/**
 * Attaches the image to the cloud machine's namespace: a new container app, or a rollout of the one
 * there; an app from before sandboxes gets room for them.
 */
const ensureCloudApp = (name: Names, image: string, say: Say) =>
  Effect.gen(function* () {
    const accountId = name.account;
    const namespaceId = yield* cloudNamespace(name);

    if (!namespaceId) return yield* new NoCloudNamespace({ className: CLOUD_CLASS, script: name.script });
    const configuration = { image, instanceType: CLOUD_INSTANCE };
    const app = yield* namespaceApp(accountId, namespaceId);

    if (!app) {
      yield* Effect.sync(() => say("Setting up the cloud machine"));
      yield* Containers.createContainerApplication({
        accountId,
        name: name.cloud,
        // Each sandbox starts when a task wakes it.
        maxInstances: CLOUD_MAX_INSTANCES,
        instances: 0,
        schedulingPolicy: "default",
        constraints: {},
        configuration,
        durableObjects: { namespaceId }
      });

      return;
    }

    // Only ever raised: a higher limit the user set stays.
    if (app.maxInstances < CLOUD_MAX_INSTANCES) {
      yield* Effect.sync(() => say("Making room for the sandboxes"));
      yield* Containers.updateContainerApplication({ accountId, applicationId: app.id, maxInstances: CLOUD_MAX_INSTANCES });
    }

    if (app.configuration.image === image) return;
    yield* Effect.sync(() => say("Rolling out the cloud machine's new image"));
    yield* Containers.updateContainerApplication({ accountId, applicationId: app.id, configuration });
    yield* Containers.createContainerApplicationRollout({
      accountId,
      applicationId: app.id,
      description: "ky deploy",
      strategy: "rolling",
      kind: "full_auto",
      stepPercentage: 100,
      targetConfiguration: configuration
    });
  });

/** Whether `rule` takes mail to `address`, and nothing else. */
const takes = (rule: EmailRouting.GetRuleResponse, address: string) =>
  rule.matchers?.length === 1 && rule.matchers[0]?.type === "literal" && rule.matchers[0].value?.toLowerCase() === address;

/** Whether `rule` hands its mail to the Worker `script`. */
const handsTo = (rule: EmailRouting.GetRuleResponse, script: string) => rule.actions?.some((action) => action.type === "worker" && action.value?.includes(script)) === true;

/**
 * The Email Routing rule that hands mail to ky's address to this Worker: made when it's missing. The address's
 * domain is a zone of the account with Email Routing on; a rule that sends the address elsewhere is the user's, and refused.
 */
const ensureMailRoute = (accountId: string, script: string, address: string) => {
  const domain = address.split("@")[1] ?? "";

  return Effect.gen(function* () {
    const [zone] = yield* list(Zones.listZones.items({ name: domain, account: { id: accountId } }));

    if (!zone) return yield* new MailDomainMissing({ domain });
    const routing = yield* EmailRouting.getEmailRouting({ zoneId: zone.id });

    if (!routing.enabled) return yield* new MailRoutingOff({ domain, accountId });
    const rules = yield* list(EmailRouting.listRules.items({ zoneId: zone.id }));
    const found = rules.find((rule) => takes(rule, address));

    if (found && handsTo(found, script)) return;

    if (found) return yield* new MailRuleElsewhere({ address, script, domain, accountId });

    yield* EmailRouting.createRule({
      zoneId: zone.id,
      name: `ky: ${script}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [{ type: "worker", value: [script] }]
    });
  }).pipe(
    Effect.catchIf(
      (error: Failure) => refused(error),
      () => Effect.fail(new MailScopes({ address, scopes: MAIL_SCOPES, page: tokenPage() }))
    )
  );
};

/** What the Worker's upload would write, as the settings Cloudflare answers compare it. */
type Upload = { compatibilityDate?: string; compatibilityFlags?: string[]; bindings: Binding[]; observability?: { enabled: boolean } };

/**
 * Whether the Worker already runs this upload: ky's tags for this release (whose version doesn't name a
 * commit), no migration to run, and settings holding the same bindings (its secrets aside), compatibility
 * and observability. Anything unsure uploads.
 */
const deployedAlready = (accountId: string, script: Script | undefined, version: string, migrating: boolean, upload: Upload) =>
  Effect.gen(function* () {
    if (!script?.id || migrating || COMMIT.test(version)) return false;

    if (!covers([...(script.tags ?? [])].sort(), [TAG, `${RELEASE_TAG}${version}`].sort())) return false;
    const settings = yield* Workers.getScriptScriptAndVersionSetting({ accountId, scriptName: script.id });
    const bound = (settings.bindings ?? []).filter((binding) => binding.type !== "secret_text");

    return (
      settings.compatibilityDate === upload.compatibilityDate &&
      covers([...(settings.compatibilityFlags ?? [])].sort(), [...(upload.compatibilityFlags ?? [])].sort()) &&
      (settings.observability?.enabled ?? false) === (upload.observability?.enabled ?? false) &&
      bound.length === upload.bindings.length &&
      upload.bindings.every((wanted) => bound.some((found) => covers(found, wanted)))
    );
  });

/** Turns workers.dev on for the Worker, unless it's on already with previews off. */
const ensureWorkersDev = (accountId: string, scriptName: string) =>
  Effect.gen(function* () {
    const now = yield* Workers.getScriptSubdomain({ accountId, scriptName });

    if (now.enabled && !now.previewsEnabled) return;
    yield* Workers.createScriptSubdomain({ accountId, scriptName, enabled: true, previewsEnabled: false });
  });

/**
 * Deploys the release: buckets, the Access apps, the web app, then the Worker with its bindings,
 * the migrations it hasn't run and `ACCESS_*`; then workers.dev.
 */
const deploy = (site: Site, release: Release, say: Say) =>
  Effect.gen(function* () {
    const { config } = site;
    const tell = (step: string) => Effect.sync(() => say(step));
    const name = yield* names(config);
    const accountId = name.account;
    const allowed = emails(config);
    const team = yield* teamDomain(accountId);

    if (!team) return yield* new ZeroTrustOff({ accountId });
    const { script, address } = yield* claim(site);
    const applied = script ? yield* migrationTag(accountId, name.script) : undefined;
    const cloud = yield* cloudState(accountId, release);
    let image: string | undefined;

    if ("image" in cloud) {
      yield* tell("Copying the cloud machine's image");
      const login = yield* registryLogin(accountId);

      image = yield* Effect.promise(() => copyImage({ source: cloud.image, account: accountId, repository: CLOUD_REPOSITORY, login }));
    } else yield* tell(`Skipping the cloud machine: ${cloud.off}`);

    yield* tell("Setting up the bucket");
    yield* ensureBuckets(name);
    yield* tell("Setting up Access");
    const aud = yield* ensureAccess(name, address, allowed);
    const migrations = yield* pendingMigrations(config.migrations ?? [], applied);
    const bound = bindings(config, name.buckets, { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ACCESS_EMAILS: allowed.join(","), ...(image && { KY_CLOUD: "1" }) });
    const observability = config.observability ? { enabled: config.observability.enabled ?? false } : undefined;

    const current =
      Array.isArray(bound) &&
      (yield* deployedAlready(accountId, script, release.version, migrations !== undefined, {
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        bindings: bound,
        observability
      }));

    yield* tell("Uploading the web app");
    const jwt = current ? "" : yield* uploadAssets(accountId, name.script, release.assets);

    yield* tell(script ? `Upgrading the Worker from ${releaseOf(script) ?? "an unknown release"} to ${release.version}` : "Uploading the Worker");

    if (!Array.isArray(bound)) return yield* bound;

    if (!current)
      yield* Workers.putScript({
        accountId,
        scriptName: name.script,
        metadata: {
          mainModule: config.main,
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          assets: { jwt, config: { notFoundHandling: config.assets?.not_found_handling, runWorkerFirst: config.assets?.run_worker_first } },
          bindings: bound,
          containers: image ? [{ className: CLOUD_CLASS }] : undefined,
          keepBindings: ["secret_text"],
          migrations,
          observability,
          tags: [TAG, `${RELEASE_TAG}${release.version}`]
        },
        files: [...release.modules].map(([module, content]) => new File([Buffer.from(content)], module, { type: "application/javascript+module" }))
      });

    if (image) yield* ensureCloudApp(name, image, say);

    yield* tell("Turning on workers.dev");
    yield* ensureWorkersDev(accountId, name.script);

    const mail = mailAddress(config);

    if (mail) {
      yield* tell(`Routing ${mail} to ky`);
      yield* ensureMailRoute(accountId, name.script, mail);
    }

    // So ky backup and ky restore find it with no Cloudflare login, only cloudflared's.
    yield* Effect.promise(() => writeDeployed(site.settings, { account: accountId, name: name.script, url: `https://${address}` }));

    const deployed: Deployed = { url: `https://${address}`, from: script ? (releaseOf(script) ?? "an unknown release") : undefined };

    return deployed;
  });

/** The release the Worker runs, or undefined when there's no Worker. */
const deployedRelease = ({ config, settings }: Site) =>
  Effect.gen(function* () {
    const script = yield* findScript(settings, yield* names(config));

    return script && (releaseOf(script) ?? "an unknown release");
  });

type Checker = (check: Check) => Effect.Effect<boolean>;

function bucketCheck(state: Out<ReturnType<typeof bucketState>>, bucketName: string, settings: string): Check {
  if (state === "ours") return { name: "Bucket", ok: true, detail: bucketName };

  if (state === "missing") return { name: "Bucket", ok: false, detail: `no bucket ${bucketName}`, next: "ky deploy" };

  if (state === "orphan") return { name: "Bucket", ok: false, detail: `${bucketName} has no ${MARKER} marker yet: a deploy stopped before writing it`, next: "ky deploy" };

  return { name: "Bucket", ok: false, detail: `${bucketName} is a bucket ky didn't create`, next: rename(settings) };
}

/** The deploy's buckets, and any Access app on its address ky didn't make. */
const ownershipChecks = (name: Names, settings: string, access: Access, address: string) =>
  Effect.gen(function* () {
    const buckets: Check[] = [];

    for (const bucket of name.buckets) buckets.push(bucketCheck(yield* bucketState(name.account, bucket.name, name.script), bucket.name, settings));

    return [...buckets, ...access.theirs.map((app): Check => ({ name: "Access", ok: false, detail: theirApp(app, address), next: rename(settings) }))];
  });

/** Whether the Worker runs this ky's release: its version, or the commit the release was built from. */
function releaseCheck(deployed: string | undefined, release: Release): Check {
  if (!runs(deployed, release)) return { name: "Release", ok: false, detail: `${deployed ?? "unknown"}, this ky is ${release.version}`, next: "ky upgrade" };

  return { name: "Release", ok: true, detail: deployed === release.version ? release.version : `${release.version}, built from ${deployed}`, next: "ky upgrade" };
}

/** Whether the Worker runs this ky's release and its migrations; a Worker past them is newer than this ky. */
function releaseChecks(deployed: string | undefined, release: Release, applied: string | undefined): Check[] {
  const migrations = release.config.migrations ?? [];
  const latest = migrations.at(-1)?.tag;

  if (newer(migrations, applied))
    return [{ name: "Release", ok: false, detail: `${deployed ?? "unknown"} ran migration ${applied}: this ky (${release.version}) is older than the Worker`, next: NEWER }];

  return [
    releaseCheck(deployed, release),
    { name: "Migrations", ok: applied === latest, detail: `${applied ?? "none"}${applied === latest ? "" : `, this release has ${latest}`}`, next: "ky deploy" }
  ];
}

/** Whether an Access app guards the address, and whether the bypass app covers every C2 path under it. */
function accessChecks(access: Access, address: string): Check[] {
  const missing = access.paths.filter((path) => !access.bypass || !guards(access.bypass).has(path));

  return [
    { name: "Access for the owner", ok: Boolean(access.owner), detail: access.owner ? address : `no Access app guards ${address}`, next: "ky deploy" },
    { name: "Access bypass", ok: missing.length === 0, detail: missing.length === 0 ? `${BYPASS.length} paths` : `doesn't cover ${missing.join(", ")}`, next: "ky deploy" }
  ];
}

/** Whether the cloud machine runs this release's image; on an account without containers, why it's off, which is fine. */
const cloudCheck = (name: Names, release: Release) =>
  Effect.gen(function* () {
    const cloud = yield* cloudState(name.account, release);

    if (!("image" in cloud)) return { name: "Cloud machine", ok: true, detail: `off, so tasks run on your computers: ${cloud.off}` } satisfies Check;
    const app = yield* cloudApp(name);

    if (!app) return { name: "Cloud machine", ok: false, detail: "no container app", next: "ky deploy" } satisfies Check;
    const digest = yield* Effect.promise(() => imageDigest(cloud.image));

    // The release names an image (or an index of them); the account's copy goes by its linux/amd64 manifest.
    if (!app.configuration.image.endsWith(`@${digest}`))
      return { name: "Cloud machine", ok: false, detail: `runs ${app.configuration.image}, not this ky's ${cloud.image}`, next: "ky deploy" } satisfies Check;

    return { name: "Cloud machine", ok: true, detail: name.cloud } satisfies Check;
  });

/** The Worker's release, migrations, Access apps and workers.dev. */
const inspectWorker = (name: Names, release: Release, script: Script, access: Access, address: string, check: Checker) =>
  Effect.gen(function* () {
    const accountId = name.account;

    for (const each of releaseChecks(releaseOf(script), release, yield* migrationTag(accountId, name.script))) yield* check(each);

    for (const each of accessChecks(access, address)) yield* check(each);
    const workersDev = yield* Workers.getScriptSubdomain({ accountId, scriptName: name.script });

    yield* check({ name: "workers.dev", ok: workersDev.enabled, detail: workersDev.enabled ? `https://${address}` : "off", next: "ky deploy" });
    yield* check(yield* cloudCheck(name, release));
  });

/** Zero Trust, workers.dev, then the names the deploy needs, then the Worker. */
const inspectAccount = ({ config, settings }: Site, release: Release, check: Checker) =>
  Effect.gen(function* () {
    const name = yield* names(config);
    const accountId = name.account;
    const team = yield* teamDomain(accountId);

    yield* check({ name: "Zero Trust", ok: Boolean(team), detail: team ?? "off", next: `turn it on at ${zeroTrustPage(accountId)} (the free plan is enough), then run \`ky deploy\`` });
    const subdomain = (yield* find(Workers.getSubdomain({ accountId }), "SubdomainNotFound"))?.subdomain;

    if (!(yield* check({ name: "workers.dev subdomain", ok: Boolean(subdomain), detail: subdomain ?? "none", next: "ky init --subdomain <name>" }))) return;
    const script = yield* existing(accountId, name.script);

    if (script && !ours(script)) {
      yield* check({ name: "Worker", ok: false, detail: `${name.script} is a Worker ky didn't deploy`, next: rename(settings) });

      return;
    }

    const address = `${name.script}.${subdomain}.workers.dev`;
    const access = yield* accessFor(accountId, address);

    for (const each of yield* ownershipChecks(name, settings, access, address)) yield* check(each);

    if (!script) {
      yield* check({ name: "Worker", ok: false, detail: `no Worker named ${name.script}`, next: "ky deploy" });

      return;
    }

    yield* check({ name: "Worker", ok: true, detail: name.script });
    yield* inspectWorker(name, release, script, access, address, check);
  });

/** Every piece of a deploy, checked in order, each with what fixes it; a refused login is a failed check too. */
const inspect = (site: Site, release: Release, login: Login) =>
  Effect.gen(function* () {
    const checks: Check[] = [];

    yield* inspectAccount(site, release, (check) => Effect.sync(() => checks.push(check) > 0 && check.ok)).pipe(
      Effect.catchIf(
        (error: Failure) => refused(error),
        () =>
          Effect.sync(() => {
            checks.push({
              name: "Cloudflare permissions",
              ok: false,
              detail: `Cloudflare refused ${login}; ky needs ${SCOPES}`,
              next: `set CLOUDFLARE_API_TOKEN to a token from ${tokenPage()}, then run \`ky doctor\``
            });
          })
      )
    );

    return checks;
  });

/** What teardown does with the bucket: removes it, leaves it (ky didn't create it, or another Worker binds it), or nothing once it's gone. */
const bucketFate = (accountId: string, bucketName: string, script: string) =>
  Effect.gen(function* () {
    const state = yield* bucketState(accountId, bucketName, script);

    if (state === "missing") return "gone" as const;

    // An unmarked bucket stays, as at B, even one a cut deploy made.
    if (state !== "ours") return { leave: "ky didn't create it" };
    const binders = yield* bindersOf(accountId, bucketName, script);

    return binders.length > 0 ? { leave: `${binders.join(", ")} binds it` } : ("remove" as const);
  });

/** ky's Access apps on the Worker's address, and the others there; undefined without a workers.dev subdomain to find them by. */
const appsAt = (name: Names) =>
  Effect.gen(function* () {
    const subdomain = (yield* find(Workers.getSubdomain({ accountId: name.account }), "SubdomainNotFound"))?.subdomain;

    if (!subdomain) return undefined;
    const access = yield* accessFor(name.account, `${name.script}.${subdomain}.workers.dev`);

    return {
      apps: [access.owner, access.bypass].flatMap((app) => (app ? [app] : [])),
      kept: access.theirs.map((app) => `the Access app ${app.name}: ky didn't make it`)
    };
  });

/**
 * What teardown removes once the Worker is gone (ky's Access apps for its address, the buckets ky
 * made that no other Worker binds), what it leaves, and whether the Access apps couldn't be found.
 */
const removable = (name: Names) =>
  Effect.gen(function* () {
    const access = yield* appsAt(name);
    const buckets: string[] = [];
    const kept: string[] = [];

    for (const bucket of name.buckets) {
      const fate = yield* bucketFate(name.account, bucket.name, name.script);

      if (fate === "remove") buckets.push(bucket.name);
      else if (fate !== "gone") kept.push(`the bucket ${bucket.name}: ${fate.leave}`);
    }

    return { apps: access?.apps ?? [], buckets, kept: [...kept, ...(access?.kept ?? [])], lost: !access };
  });

/**
 * Removes the Worker (its Durable Objects' data and secrets go with it), then its Access apps and
 * buckets; when the Access apps can't be found, it says so and the overlay stays.
 */
const teardown = ({ config, settings }: Site, say: Say) =>
  Effect.gen(function* () {
    const tell = (step: string) => Effect.sync(() => say(step));
    const name = yield* names(config);
    const accountId = name.account;
    const script = yield* existing(accountId, name.script);

    if (script && !ours(script)) return yield* new NotOurWorker({ script: name.script, settings });

    // The container app first: it holds on to the Worker's namespace.
    const app = script ? yield* cloudApp(name) : undefined;

    if (app) {
      yield* tell("Removing the cloud machine");
      yield* find(Containers.deleteContainerApplication({ accountId, applicationId: app.id }), "ContainerApplicationNotFound");
    }

    if (script) {
      yield* tell("Removing the Worker and its data");
      yield* Workers.deleteScript({ accountId, scriptName: name.script, force: true });
    }

    const { apps, buckets, kept, lost } = yield* removable(name);

    if (apps.length > 0) yield* tell("Removing the Access apps");

    for (const each of apps) if (each.id) yield* ZeroTrust.deleteAccessApplicationForAccount({ accountId, appId: each.id });

    for (const bucketName of buckets) {
      yield* tell(`Emptying and removing the bucket ${bucketName}`);
      const keys = (yield* list(R2.listObjects.items({ accountId, bucketName, perPage: 1000 }))).flatMap((object) => (object.key ? [object.key] : []));

      for (let i = 0; i < keys.length; i += 1000) yield* R2.deleteObjects({ accountId, bucketName, body: keys.slice(i, i + 1000) });
      yield* R2.deleteBucket({ accountId, bucketName });
    }

    for (const left of kept) yield* tell(`Leaving ${left}`);

    if (lost) return yield* new AppsLost({ script: name.script, accountId, settings });
  });

/** What teardown should have removed that's still in the account. */
const leftovers = ({ config }: Site) =>
  Effect.gen(function* () {
    const name = yield* names(config);
    const worker = yield* existing(name.account, name.script);
    const { apps, buckets } = yield* removable(name);
    const containers = (yield* runsContainers(name.account))
      ? (yield* Containers.listContainerApplications({ accountId: name.account })).filter((app) => app.name === name.cloud)
      : [];

    return [
      ...(worker ? [`Worker ${name.script}`] : []),
      ...containers.map((app) => `Container app ${app.name}`),
      ...buckets.map((bucket) => `Bucket ${bucket}`),
      ...apps.map((app) => `Access app ${app.name}`)
    ];
  });

export interface DeployerShape {
  readonly claim: (site: Site) => Op<{ script: Script | undefined; address: string }>;
  readonly address: (site: Site) => Op<string>;
  readonly teamDomain: (accountId: string) => Op<string | undefined>;
  readonly deploy: (site: Site, release: Release, say: Say) => Op<Deployed>;
  readonly deployedRelease: (site: Site) => Op<string | undefined>;
  readonly inspect: (site: Site, release: Release, login: Login) => Op<Check[]>;
  readonly teardown: (site: Site, say: Say) => Op<void>;
  readonly leftovers: (site: Site) => Op<string[]>;
}

export class Deployer extends Context.Service<Deployer, DeployerShape>()("ky/deploy/Deployer") {
  /** Needs nothing but distilled's login, which each action asks for and the edge provides. */
  static readonly layer = Layer.succeed(Deployer)({
    claim,
    address: ({ config }) =>
      Effect.gen(function* () {
        const name = yield* names(config);

        return `https://${yield* host(name.account, name.script)}`;
      }),
    teamDomain,
    deploy,
    deployedRelease,
    inspect,
    teardown,
    leftovers
  });
}
