import { createHash } from "node:crypto";
import { extname } from "node:path";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as DurableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as EmailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as R2 from "@distilled.cloud/cloudflare/r2";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as ZeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Unstable_RawConfig } from "wrangler";
import { BYPASS } from "../../src/access.ts";
import { getService, type Login, MAIL_SCOPES, SCOPES, tokenPage } from "../cloudflare.ts";
import { emails, mailAddress, writeDeployed } from "../config.ts";
import { copyImage, imageDigest, TARGET } from "../image.ts";
import { type Release, releaseImage, runs } from "../release.ts";
import {
  AppsLost,
  BucketName,
  CantDeployKey,
  type Check,
  type Deployed,
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

const CLOUD_CLASS = "CloudMachine";

const CLOUD_REPOSITORY = "ky-cloud";

const CLOUD_INSTANCE = "standard-1";

const CLOUD_MAX_INSTANCES = 9;

const REFUSALS = new Set(["Forbidden", "Unauthorized"]);

const COMMIT = /^[0-9a-f]{7,}$/;

function plansPage(accountId: string): string {
  return `https://dash.cloudflare.com/${accountId}/workers/plans`;
}

interface Failure {
  readonly _tag: string;
}

type Say = (step: string) => void;

export type Site = { readonly config: Unstable_RawConfig; readonly settings: string };

type Binding = Workers.PutScriptBinding;

type Migrations = NonNullable<Unstable_RawConfig["migrations"]>;

type Out<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

type Script = Out<ReturnType<typeof scripts>>[number];

type FoundApp = Out<ReturnType<typeof accessApps>>[number];

type Names = Out<ReturnType<typeof names>>;

const find = <A, E extends Failure, R>(operation: Effect.Effect<A, E, R>, ...missing: string[]) =>
  operation.pipe(
    Effect.catchIf(
      (error: E) => missing.includes(error._tag),
      () => Effect.succeed(undefined)
    )
  );

const refused = (error: Failure) => REFUSALS.has(error._tag);

type Bound = { readonly type: string };

const defined = (binding: Bound) => Object.fromEntries(Object.entries(binding).filter(([, each]) => each !== undefined));

const sameNames = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) => Equal.equals([...(a ?? [])].sort(), [...(b ?? [])].sort());

function required<T>(value: T | undefined, what: string): Effect.Effect<T, NoConfig> {
  return value === undefined || value === "" ? Effect.fail(new NoConfig({ what })) : Effect.succeed(value);
}

const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function bucketFor(script: string, binding: string): Effect.Effect<{ binding: string; name: string }, BucketName> {
  const bucketName = `${script}-${binding.toLowerCase().replaceAll("_", "-")}`;

  return BUCKET.test(bucketName) ? Effect.succeed({ binding, name: bucketName }) : Effect.fail(new BucketName({ binding, bucketName }));
}

const names = (config: Unstable_RawConfig) =>
  Effect.gen(function* () {
    const script = yield* required(config.name, "name");
    const account = yield* required(config.account_id, "account_id");
    const buckets = yield* Effect.forEach(config.r2_buckets ?? [], (bucket) => bucketFor(script, bucket.binding));

    return { account, script, access: script, bypass: `${script} bypass`, buckets, cloud: `${script}-cloud` };
  });

function releaseOf(script: Script): string | undefined {
  return script.tags?.find((tag) => tag.startsWith(RELEASE_TAG))?.slice(RELEASE_TAG.length);
}

const ranRelease = (script: Script | undefined) => script && (releaseOf(script) ?? "an unknown release");

function scripts(accountId: string) {
  return Stream.runCollect(Workers.listScripts.items({ accountId }));
}

const existing = (accountId: string, name: string) => Effect.map(scripts(accountId), (all) => all.find((candidate) => candidate.id === name));

function ours(script: Script): boolean {
  return script.tags?.includes(TAG) ?? false;
}

const findScript = (settings: string, name: Names) =>
  Effect.gen(function* () {
    const script = yield* existing(name.account, name.script);

    if (script && !ours(script)) return yield* new Taken({ taken: `A Worker named ${name.script} is already in this account and ky didn't deploy it`, settings });

    return script;
  });

const migrationTag = (accountId: string, name: string) =>
  Effect.map(getService({ accountId, serviceName: name }), (service) => service.defaultEnvironment.script.migrationTag ?? undefined);

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

const bucketState = (accountId: string, bucketName: string, script: string) =>
  Effect.gen(function* () {
    if (!(yield* find(R2.getBucket({ accountId, bucketName }), "NoSuchBucket"))) return "missing" as const;
    const marked = yield* Stream.runCollect(R2.listObjects.items({ accountId, bucketName, prefix: MARKER }));

    if (marked.some((object) => object.key === MARKER)) return "ours" as const;
    const [first] = yield* Stream.runCollect(Stream.take(R2.listObjects.items({ accountId, bucketName }), 1));

    if (first || (yield* bindersOf(accountId, bucketName, script)).length > 0) return "theirs" as const;

    return "orphan" as const;
  });

const host = (accountId: string, name: string) =>
  Effect.gen(function* () {
    const subdomain = yield* find(Workers.getSubdomain({ accountId }), "SubdomainNotFound");

    if (!subdomain?.subdomain) return yield* new NoSubdomain();

    return `${name}.${subdomain.subdomain}.workers.dev`;
  });

const teamDomain = (accountId: string) =>
  Effect.map(find(ZeroTrust.listOrganizationsForAccount({ accountId }), "OrganizationNotFound"), (organization) => organization?.authDomain ?? undefined);

function normal(uri: string): string {
  return uri
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function accessApps(accountId: string) {
  return Stream.runCollect(ZeroTrust.listAccessApplicationsForAccount.items({ accountId }));
}

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

function newer(migrations: Migrations, applied: string | undefined): boolean {
  return applied !== undefined && !migrations.some((migration) => migration.tag === applied);
}

function pendingMigrations(migrations: Migrations, applied: string | undefined) {
  if (applied !== undefined && newer(migrations, applied)) return new OlderThanWorker({ applied });
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

const ensureTag = (accountId: string) =>
  Effect.gen(function* () {
    if ((yield* Stream.runCollect(ZeroTrust.listAccessTags.items({ accountId }))).some((tag) => tag.name === TAG)) return;
    yield* ZeroTrust.createAccessTag({ accountId, name: TAG });
  });

const Rule = Schema.Union([Schema.Struct({ email: Schema.Struct({ email: Schema.String }) }), Schema.Struct({ everyone: Schema.Struct({}) })]);

const AppSettings = Schema.Struct({
  name: Schema.String,
  destinations: Schema.Array(Schema.Struct({ type: Schema.Literal("public"), uri: Schema.String })),
  policies: Schema.Array(Schema.Struct({ name: Schema.String, decision: Schema.Literals(["allow", "bypass"]), include: Schema.Array(Rule) }))
});

type AppSettings = typeof AppSettings.Type;

const readApp = Schema.decodeUnknownOption(
  Schema.Struct({ ...AppSettings.fields, aud: Schema.NonEmptyString, type: Schema.Literal("self_hosted"), tags: Schema.Tuple([Schema.Literal(TAG)]) })
);

const compared = (app: AppSettings) => ({ ...app, destinations: app.destinations.map((destination) => normal(destination.uri)) });

function unchanged(found: FoundApp | undefined, settings: AppSettings): string | undefined {
  return Option.getOrUndefined(Option.filter(readApp(found), (app) => Equal.equals(compared({ name: app.name, destinations: app.destinations, policies: app.policies }), compared(settings))))?.aud;
}

const saveApp = (accountId: string, found: FoundApp | undefined, settings: AppSettings) =>
  Effect.gen(function* () {
    const current = unchanged(found, settings);

    if (current) return current;
    const app = { accountId, type: "self_hosted", tags: [TAG], name: settings.name, destinations: [...settings.destinations], policies: settings.policies.map((policy) => ({ ...policy, include: [...policy.include] })) };
    const saved = found?.id ? yield* ZeroTrust.updateAccessApplicationForAccount({ appId: found.id, ...app }) : yield* ZeroTrust.createAccessApplicationForAccount(app);

    if (!("aud" in saved) || !saved.aud) return yield* new NoAudience({ app: settings.name });

    return saved.aud;
  });

const ensureAccess = (name: Names, address: string, allowed: string[]) =>
  Effect.gen(function* () {
    const accountId = name.account;
    const found = yield* accessFor(accountId, address);

    yield* ensureTag(accountId);

    const aud = yield* saveApp(accountId, found.owner, {
      name: name.access,
      destinations: [{ type: "public", uri: address }],
      policies: [{ name: "owner", decision: "allow", include: allowed.map((email) => ({ email: { email } })) }]
    });

    yield* saveApp(accountId, found.bypass, {
      name: name.bypass,
      destinations: BYPASS.map((path) => ({ type: "public", uri: `${address}${path}` })),
      policies: [{ name: "runners and files", decision: "bypass", include: [{ everyone: {} }] }]
    });

    return aud;
  });

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

const runsContainers = (accountId: string) =>
  Containers.getContainerIdentity({ accountId }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error: Failure) => error._tag !== "HttpClientError",
      () => Effect.succeed(false)
    )
  );

const cloudState = (accountId: string, release: Release) =>
  Effect.gen(function* () {
    const none = { off: "this ky's release has no cloud machine image" };

    if (!release.image && !release.imageFrom) return none;

    if (!(yield* runsContainers(accountId)))
      return { off: `this account can't run containers: it needs Workers Paid (${plansPage(accountId)}), and a login with Containers: Edit` };
    const image = yield* Effect.promise(() => releaseImage(release));

    return image ? { image } : none;
  });

const cloudNamespace = (name: Names) =>
  Effect.map(
    Stream.runCollect(DurableObjects.listNamespaces.items({ accountId: name.account })),
    (namespaces) => namespaces.find((namespace) => namespace.script === name.script && namespace.class === CLOUD_CLASS)?.id ?? undefined
  );

const namespaceApp = (accountId: string, namespaceId: string) =>
  Effect.gen(function* () {
    const listed = (yield* Containers.listContainerApplications({ accountId })).find((app) => app.durableObjects?.namespaceId === namespaceId);

    return listed && (yield* Containers.getContainerApplication({ accountId, applicationId: listed.id }));
  });

const cloudApp = (name: Names) =>
  Effect.gen(function* () {
    if (!(yield* runsContainers(name.account))) return undefined;
    const namespaceId = yield* cloudNamespace(name);

    if (!namespaceId) return undefined;

    return yield* namespaceApp(name.account, namespaceId);
  });

const registryLogin = (accountId: string) =>
  Effect.gen(function* () {
    const credential = yield* Containers.createContainerRegistryCredentials({ accountId, registryId: TARGET, permissions: ["pull", "push"], expirationMinutes: 15 });
    const username = credential.username ?? credential.user;

    if (!username) return yield* new NoRegistryLogin();

    return { username, password: credential.password };
  });

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
        maxInstances: CLOUD_MAX_INSTANCES,
        instances: 0,
        schedulingPolicy: "default",
        constraints: {},
        configuration,
        durableObjects: { namespaceId }
      });

      return;
    }

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

const takes = (rule: EmailRouting.GetRuleResponse, address: string) =>
  rule.matchers?.length === 1 && rule.matchers[0]?.type === "literal" && rule.matchers[0].value?.toLowerCase() === address;

const handsTo = (rule: EmailRouting.GetRuleResponse, script: string) => rule.actions?.some((action) => action.type === "worker" && action.value?.includes(script)) === true;

const ensureMailRoute = (accountId: string, script: string, address: string) => {
  const domain = address.split("@")[1] ?? "";

  return Effect.gen(function* () {
    const [zone] = yield* Stream.runCollect(Zones.listZones.items({ name: domain, account: { id: accountId } }));

    if (!zone) return yield* new MailDomainMissing({ domain });
    const routing = yield* EmailRouting.getEmailRouting({ zoneId: zone.id });

    if (!routing.enabled) return yield* new MailRoutingOff({ domain, accountId });
    const rules = yield* Stream.runCollect(EmailRouting.listRules.items({ zoneId: zone.id }));
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

type Upload = {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  bindings: Binding[];
  observability?: { enabled: boolean };
  migrations: Exclude<ReturnType<typeof pendingMigrations>, OlderThanWorker>;
};

const deployedAlready = (accountId: string, script: Script | undefined, version: string, upload: Upload) =>
  Effect.gen(function* () {
    if (!script?.id || upload.migrations || COMMIT.test(version) || !sameNames(script.tags, [TAG, `${RELEASE_TAG}${version}`])) return false;
    const settings = yield* Workers.getScriptScriptAndVersionSetting({ accountId, scriptName: script.id });

    return Equal.equals(uploaded(settings), uploaded(upload)) && sameBindings(settings.bindings, upload.bindings);
  });

type UploadSettings = {
  readonly compatibilityDate?: string | null;
  readonly compatibilityFlags?: readonly string[] | null;
  readonly observability?: { readonly enabled?: boolean | null } | null;
};

const uploaded = (upload: UploadSettings) => ({
  date: upload.compatibilityDate ?? undefined,
  flags: [...(upload.compatibilityFlags ?? [])].sort(),
  observed: upload.observability?.enabled ?? false
});

function sameBindings(found: readonly Bound[] | null | undefined, wanted: readonly Binding[]): boolean {
  const bound = (found ?? []).filter((binding) => binding.type !== "secret_text");

  return bound.length === wanted.length && wanted.every((each) => bound.some((binding) => Equal.equals(defined(binding), defined(each))));
}

const ensureWorkersDev = (accountId: string, scriptName: string) =>
  Effect.gen(function* () {
    const now = yield* Workers.getScriptSubdomain({ accountId, scriptName });

    if (now.enabled && !now.previewsEnabled) return;
    yield* Workers.createScriptSubdomain({ accountId, scriptName, enabled: true, previewsEnabled: false });
  });

const cloudImage = (accountId: string, release: Release, tell: (step: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const cloud = yield* cloudState(accountId, release);

    if (!("image" in cloud)) {
      yield* tell(`Skipping the cloud machine: ${cloud.off}`);

      return undefined;
    }

    yield* tell("Copying the cloud machine's image");
    const login = yield* registryLogin(accountId);

    return yield* Effect.promise(() => copyImage({ source: cloud.image, account: accountId, repository: CLOUD_REPOSITORY, login }));
  });

function upload(
  config: Unstable_RawConfig,
  buckets: Names["buckets"],
  { access, image, applied }: { access: Record<string, string>; image: string | undefined; applied: string | undefined }
): { upload: Upload } | { refused: CantDeployKey | OlderThanWorker } {
  const bound = bindings(config, buckets, { ...access, ...(image && { KY_CLOUD: "1" }) });
  const migrations = pendingMigrations(config.migrations ?? [], applied);

  if (!Array.isArray(bound)) return { refused: bound };

  if (migrations instanceof OlderThanWorker) return { refused: migrations };

  return {
    upload: {
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      bindings: bound,
      observability: config.observability && { enabled: config.observability.enabled ?? false },
      migrations
    }
  };
}

const putWorker = (
  name: Names,
  config: Unstable_RawConfig,
  release: Release,
  { jwt, image, ...settings }: Upload & { jwt: string; image: string | undefined }
) =>
  Workers.putScript({
    accountId: name.account,
    scriptName: name.script,
    metadata: {
      ...settings,
      mainModule: config.main,
      assets: { jwt, config: { notFoundHandling: config.assets?.not_found_handling, runWorkerFirst: config.assets?.run_worker_first } },
      containers: image ? [{ className: CLOUD_CLASS }] : undefined,
      keepBindings: ["secret_text"],
      tags: [TAG, `${RELEASE_TAG}${release.version}`]
    },
    files: [...release.modules].map(([module, content]) => new File([Buffer.from(content)], module, { type: "application/javascript+module" }))
  });

const routeMail = (config: Unstable_RawConfig, name: Names, tell: (step: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const mail = mailAddress(config);

    if (!mail) return;
    yield* tell(`Routing ${mail} to ky`);
    yield* ensureMailRoute(name.account, name.script, mail);
  });

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
    const image = yield* cloudImage(accountId, release, tell);

    yield* tell("Setting up the bucket");
    yield* ensureBuckets(name);
    yield* tell("Setting up Access");
    const aud = yield* ensureAccess(name, address, allowed);
    const worker = upload(config, name.buckets, { access: { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ACCESS_EMAILS: allowed.join(",") }, image, applied });
    const current = "upload" in worker && (yield* deployedAlready(accountId, script, release.version, worker.upload));
    const from = ranRelease(script);

    yield* tell("Uploading the web app");
    const jwt = current ? "" : yield* uploadAssets(accountId, name.script, release.assets);

    yield* tell(from ? `Upgrading the Worker from ${from} to ${release.version}` : "Uploading the Worker");

    if ("refused" in worker) return yield* worker.refused;

    if (!current) yield* putWorker(name, config, release, { ...worker.upload, jwt, image });

    if (image) yield* ensureCloudApp(name, image, say);

    yield* tell("Turning on workers.dev");
    yield* ensureWorkersDev(accountId, name.script);
    yield* routeMail(config, name, tell);

    yield* Effect.promise(() => writeDeployed(site.settings, { account: accountId, name: name.script, url: `https://${address}` }));

    return { url: `https://${address}`, from } satisfies Deployed;
  });

const deployedRelease = ({ config, settings }: Site) =>
  Effect.gen(function* () {
    const script = yield* findScript(settings, yield* names(config));

    return ranRelease(script);
  });

type Checker = (check: Check) => Effect.Effect<boolean>;

function bucketCheck(state: Out<ReturnType<typeof bucketState>>, bucketName: string, settings: string): Check {
  if (state === "ours") return { name: "Bucket", ok: true, detail: bucketName };

  if (state === "missing") return { name: "Bucket", ok: false, detail: `no bucket ${bucketName}`, next: "ky deploy" };

  if (state === "orphan") return { name: "Bucket", ok: false, detail: `${bucketName} has no ${MARKER} marker yet: a deploy stopped before writing it`, next: "ky deploy" };

  return { name: "Bucket", ok: false, detail: `${bucketName} is a bucket ky didn't create`, next: rename(settings) };
}

const ownershipChecks = (name: Names, settings: string, access: Access, address: string) =>
  Effect.gen(function* () {
    const buckets: Check[] = [];

    for (const bucket of name.buckets) buckets.push(bucketCheck(yield* bucketState(name.account, bucket.name, name.script), bucket.name, settings));

    return [...buckets, ...access.theirs.map((app): Check => ({ name: "Access", ok: false, detail: theirApp(app, address), next: rename(settings) }))];
  });

function releaseCheck(deployed: string | undefined, release: Release): Check {
  if (!runs(deployed, release)) return { name: "Release", ok: false, detail: `${deployed ?? "unknown"}, this ky is ${release.version}`, next: "ky upgrade" };

  return { name: "Release", ok: true, detail: deployed === release.version ? release.version : `${release.version}, built from ${deployed}`, next: "ky upgrade" };
}

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

function accessChecks(access: Access, address: string): Check[] {
  const missing = access.paths.filter((path) => !access.bypass || !guards(access.bypass).has(path));

  return [
    { name: "Access for the owner", ok: Boolean(access.owner), detail: access.owner ? address : `no Access app guards ${address}`, next: "ky deploy" },
    { name: "Access bypass", ok: missing.length === 0, detail: missing.length === 0 ? `${BYPASS.length} paths` : `doesn't cover ${missing.join(", ")}`, next: "ky deploy" }
  ];
}

const cloudCheck = (name: Names, release: Release) =>
  Effect.gen(function* () {
    const cloud = yield* cloudState(name.account, release);

    if (!("image" in cloud)) return { name: "Cloud machine", ok: true, detail: `off, so tasks run on your computers: ${cloud.off}` } satisfies Check;
    const app = yield* cloudApp(name);

    if (!app) return { name: "Cloud machine", ok: false, detail: "no container app", next: "ky deploy" } satisfies Check;
    const digest = yield* Effect.promise(() => imageDigest(cloud.image));

    if (!app.configuration.image.endsWith(`@${digest}`))
      return { name: "Cloud machine", ok: false, detail: `runs ${app.configuration.image}, not this ky's ${cloud.image}`, next: "ky deploy" } satisfies Check;

    return { name: "Cloud machine", ok: true, detail: name.cloud } satisfies Check;
  });

const inspectWorker = (name: Names, release: Release, script: Script, access: Access, address: string, check: Checker) =>
  Effect.gen(function* () {
    const accountId = name.account;

    for (const each of releaseChecks(releaseOf(script), release, yield* migrationTag(accountId, name.script))) yield* check(each);

    for (const each of accessChecks(access, address)) yield* check(each);
    const workersDev = yield* Workers.getScriptSubdomain({ accountId, scriptName: name.script });

    yield* check({ name: "workers.dev", ok: workersDev.enabled, detail: workersDev.enabled ? `https://${address}` : "off", next: "ky deploy" });
    yield* check(yield* cloudCheck(name, release));
  });

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

const bucketFate = (accountId: string, bucketName: string, script: string) =>
  Effect.gen(function* () {
    const state = yield* bucketState(accountId, bucketName, script);

    if (state === "missing") return "gone" as const;

    if (state !== "ours") return { leave: "ky didn't create it" };
    const binders = yield* bindersOf(accountId, bucketName, script);

    return binders.length > 0 ? { leave: `${binders.join(", ")} binds it` } : ("remove" as const);
  });

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

const removeWorker = (name: Names, tell: (step: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const app = yield* cloudApp(name);

    if (app) {
      yield* tell("Removing the cloud machine");
      yield* find(Containers.deleteContainerApplication({ accountId: name.account, applicationId: app.id }), "ContainerApplicationNotFound");
    }

    yield* tell("Removing the Worker and its data");
    yield* Workers.deleteScript({ accountId: name.account, scriptName: name.script, force: true });
  });

const removeApps = (accountId: string, apps: readonly FoundApp[], tell: (step: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    if (apps.length > 0) yield* tell("Removing the Access apps");

    for (const each of apps) if (each.id) yield* ZeroTrust.deleteAccessApplicationForAccount({ accountId, appId: each.id });
  });

const removeBucket = (accountId: string, bucketName: string) =>
  Effect.gen(function* () {
    const keys = (yield* Stream.runCollect(R2.listObjects.items({ accountId, bucketName, perPage: 1000 }))).flatMap((object) => (object.key ? [object.key] : []));

    for (let i = 0; i < keys.length; i += 1000) yield* R2.deleteObjects({ accountId, bucketName, body: keys.slice(i, i + 1000) });
    yield* R2.deleteBucket({ accountId, bucketName });
  });

const teardown = ({ config, settings }: Site, say: Say) =>
  Effect.gen(function* () {
    const tell = (step: string) => Effect.sync(() => say(step));
    const name = yield* names(config);
    const accountId = name.account;
    const script = yield* existing(accountId, name.script);

    if (script && !ours(script)) return yield* new NotOurWorker({ script: name.script, settings });

    if (script) yield* removeWorker(name, tell);
    const { apps, buckets, kept, lost } = yield* removable(name);

    yield* removeApps(accountId, apps, tell);

    for (const bucketName of buckets) {
      yield* tell(`Emptying and removing the bucket ${bucketName}`);
      yield* removeBucket(accountId, bucketName);
    }

    for (const left of kept) yield* tell(`Leaving ${left}`);

    if (lost) return yield* new AppsLost({ script: name.script, accountId, settings });
  });

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

const address = ({ config }: Site) =>
  Effect.gen(function* () {
    const name = yield* names(config);

    return `https://${yield* host(name.account, name.script)}`;
  });

export const Deployer = { claim, address, teamDomain, deploy, deployedRelease, inspect, teardown, leftovers };
