/**
 * A fake Cloudflare API for the `ky` CLI: the routes cli/deployer.ts and cli/init.ts call, in
 * Cloudflare's wire format (the v4 envelope, snake_case, page-mode lists, multipart uploads), over
 * a little account kept in memory. The CLI reaches it as it would the real one, through
 * @distilled.cloud/cloudflare with CLOUDFLARE_API_BASE_URL pointed here.
 *
 * It holds Cloudflare to what the deployer depends on: a migration whose old tag isn't the
 * Worker's is refused, a Worker's main module must be among its files, assets need the upload
 * session's completion token, a bucket with objects in it can't be deleted, and an Access app's
 * tags must be the account's already. A wrangler login (WRANGLER_TOKEN) is refused on every Access
 * route, as Cloudflare refuses wrangler's OAuth scopes. Containers answer only on a paid account,
 * and a container app attaches only to a Durable Object class its Worker marks as a container.
 */
import { createServer, type IncomingMessage } from "node:http";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { REGISTRY_LOGIN } from "./registry.ts";

const Migration = Type.Object({
  old_tag: Type.Optional(Type.String()),
  new_tag: Type.Optional(Type.String()),
  steps: Type.Array(
    Type.Object({
      new_sqlite_classes: Type.Optional(Type.Array(Type.String())),
      new_classes: Type.Optional(Type.Array(Type.String())),
      deleted_classes: Type.Optional(Type.Array(Type.String())),
      renamed_classes: Type.Optional(Type.Array(Type.Object({ from: Type.String(), to: Type.String() }))),
      transferred_classes: Type.Optional(Type.Array(Type.Object({ from: Type.String(), from_script: Type.String(), to: Type.String() })))
    })
  )
});

/** The part of a Worker upload's metadata the fake reads or the tests check; the rest is kept as sent. */
const Metadata = Type.Object({
  main_module: Type.String(),
  compatibility_date: Type.Optional(Type.String()),
  compatibility_flags: Type.Optional(Type.Array(Type.String())),
  tags: Type.Optional(Type.Array(Type.String())),
  keep_bindings: Type.Optional(Type.Array(Type.String())),
  bindings: Type.Optional(
    Type.Array(
      Type.Object({ type: Type.String(), name: Type.String(), text: Type.Optional(Type.String()), bucket_name: Type.Optional(Type.String()) })
    )
  ),
  migrations: Type.Optional(Migration),
  containers: Type.Optional(Type.Array(Type.Object({ class_name: Type.String() }))),
  observability: Type.Optional(Type.Object({ enabled: Type.Boolean() })),
  assets: Type.Optional(
    Type.Object({
      jwt: Type.Optional(Type.String()),
      config: Type.Optional(
        Type.Object({ not_found_handling: Type.Optional(Type.String()), run_worker_first: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])) })
      )
    })
  )
});

const AppBody = Type.Object({
  name: Type.String(),
  type: Type.String(),
  tags: Type.Optional(Type.Array(Type.String())),
  destinations: Type.Array(Type.Object({ type: Type.String(), uri: Type.Optional(Type.String()) })),
  policies: Type.Array(Type.Object({ name: Type.String(), decision: Type.String(), include: Type.Array(Type.Unknown()) }))
});

const Configuration = Type.Object({ image: Type.String(), instance_type: Type.Optional(Type.String()) });

const ContainerAppBody = Type.Object({
  name: Type.String(),
  max_instances: Type.Number(),
  instances: Type.Optional(Type.Number()),
  scheduling_policy: Type.Optional(Type.String()),
  constraints: Type.Optional(Type.Unknown()),
  configuration: Configuration,
  durable_objects: Type.Optional(Type.Object({ namespace_id: Type.String() }))
});

export type FakeScript = {
  tags: string[];
  migrationTag?: string;
  /** Every migration upload, as sent. */
  migrations: Static<typeof Migration>[];
  /** The last upload's metadata, as sent. */
  metadata: Static<typeof Metadata>;
  modules: string[];
  secrets: Map<string, string>;
  workersDev: boolean;
};

export type FakeApp = Static<typeof AppBody> & { id: string; aud: string };

export type FakeContainerApp = Static<typeof ContainerAppBody> & {
  id: string;
  rollouts: Static<typeof Configuration>[];
  /** What the account's list of apps says the app runs, when it lags the app: after a rollout, Cloudflare's list went on naming the old image. */
  listed?: Static<typeof Configuration>;
};

export type FakeAccount = {
  id: string;
  name: string;
  subdomain?: string;
  /** The Zero Trust organization's auth domain; undefined until Zero Trust is on. */
  team?: string;
  scripts: Map<string, FakeScript>;
  /** Bucket name to its object keys. */
  buckets: Map<string, Set<string>>;
  apps: Map<string, FakeApp>;
  /** The account's Access tags. */
  tags: Set<string>;
  /** Asset hashes uploaded so far. */
  assets: Set<string>;
  /** Workers Paid: containers answer. */
  paid: boolean;
  /** Container apps by id. */
  containerApps: Map<string, FakeContainerApp>;
  /** The account's domains, by zone id. */
  zones: Map<string, FakeZone>;
};

export type FakeRule = { id: string; name: string; enabled: boolean; matchers: { type: string; field?: string; value?: string }[]; actions: { type: string; value?: string[] }[] };

/** A domain on the account, with Email Routing on or off and its routing rules. */
export type FakeZone = { id: string; name: string; routing: boolean; rules: FakeRule[] };

export function fakeZone(name: string, zone: Partial<FakeZone> = {}): FakeZone {
  return { id: `zone-${name}`, name, routing: true, rules: [], ...zone };
}

export type FakeCloudflare = {
  url: string;
  accounts: Map<string, FakeAccount>;
  /** Every call to an account, in order: its method and the path under the account. */
  requests: string[];
  close: () => Promise<void>;
};

/** The token a wrangler login gives: it deploys Workers, but Access refuses it. */
export const WRANGLER_TOKEN = "wrangler-oauth-token";

/** A token made without Access: Organizations, Identity Providers, and Groups: Read; Cloudflare refuses it the organization. */
export const NO_ORGANIZATION_TOKEN = "token-without-access-organizations";

const UPLOAD = "upload-session";

const COMPLETED = "assets-complete";

class Failure extends Error {
  readonly status: number;
  readonly code: number;

  constructor(status: number, code: number, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function fakeAccount(id: string, name: string, account: Partial<FakeAccount> = {}): FakeAccount {
  return { id, name, scripts: new Map(), buckets: new Map(), apps: new Map(), tags: new Set(), assets: new Set(), paid: false, containerApps: new Map(), zones: new Map(), ...account };
}

async function body(message: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];

  for await (const chunk of message) chunks.push(Buffer.from(chunk));

  return new Uint8Array(Buffer.concat(chunks));
}

/** A JSON body, refused as Cloudflare refuses one that isn't what the route takes. */
function decode<Schema extends TSchema>(schema: Schema, text: string): Static<Schema> {
  const value = JSON.parse(text);

  if (!Value.Check(schema, value)) throw new Failure(400, 10026, `Malformed request body: ${text}`);

  return value;
}

/** One page of a page-mode list: the items on page 1, none after. */
class Page {
  readonly result: unknown[];
  readonly result_info: { page: number; per_page: number; count: number; total_count: number };

  constructor(items: unknown[], url: URL) {
    const page = Number(url.searchParams.get("page") ?? 1);

    this.result = page === 1 ? items : [];
    this.result_info = { page, per_page: items.length, count: this.result.length, total_count: items.length };
  }
}

function scriptItem(id: string, script: FakeScript) {
  return { id, tag: `tag-${id}`, tags: script.tags, has_assets: true, has_modules: true };
}

/** The Worker's service, where wrangler reads its migration tag. */
function service(call: Call) {
  const script = scriptNamed(call);

  return {
    id: call.name,
    default_environment: { environment: "production", script: { ...scriptItem(call.name, script), migration_tag: script.migrationTag ?? null } }
  };
}

function app(found: FakeApp) {
  return { ...found, domain: found.destinations[0]?.uri };
}

/** One call to an account's API: its account, the request, and the name and object key in its path, if any. */
type Call = { account: FakeAccount; request: Request; url: URL; name: string; key: string };

type Handler = (call: Call) => object | null | Promise<object | null>;

function scriptNamed({ account, name }: Call): FakeScript {
  const script = account.scripts.get(name);

  if (!script) throw new Failure(404, 10007, "This Worker does not exist on your account.");

  return script;
}

function bucketNamed({ account, name }: Call): Set<string> {
  const bucket = account.buckets.get(name);

  if (!bucket) throw new Failure(404, 10006, "The specified bucket does not exist.");

  return bucket;
}

function subdomain({ account }: Call) {
  if (!account.subdomain) throw new Failure(404, 10007, "This account does not have a workers.dev subdomain.");

  return { subdomain: account.subdomain };
}

async function uploadAssets({ account, request }: Call) {
  if (request.headers.get("authorization") !== `Bearer ${UPLOAD}`) throw new Failure(401, 10000, "Authentication error");

  for (const [hash] of await request.formData()) account.assets.add(hash);

  return { jwt: COMPLETED };
}

/** An upload session: the hashes Cloudflare doesn't have yet, in one bucket. */
async function assetSession({ account, request }: Call) {
  const { manifest } = decode(Type.Object({ manifest: Type.Record(Type.String(), Type.Object({ hash: Type.String() })) }), await request.text());
  const missing = [...new Set(Object.values(manifest).map((file) => file.hash))].filter((hash) => !account.assets.has(hash));

  return missing.length > 0 ? { jwt: UPLOAD, buckets: [missing] } : { jwt: COMPLETED, buckets: [] };
}

/** Refuses an upload as Cloudflare would: a main module it lacks, assets not uploaded, or a migration from another tag. */
function refuseUpload(metadata: FakeScript["metadata"], modules: string[], migrationTag: string | undefined): void {
  if (!modules.includes(metadata.main_module)) throw new Failure(400, 10021, `No such module "${metadata.main_module}"`);

  if (metadata.assets && metadata.assets.jwt !== COMPLETED) throw new Failure(400, 10021, "The assets' completion token is missing or wrong");

  if (metadata.migrations && metadata.migrations.old_tag !== migrationTag)
    throw new Failure(400, 10079, `Migration tag precondition failed; current tag is ${migrationTag}`);
}

/** A Worker upload: `metadata` as JSON, then each module under its own name. */
async function putScript({ account, request, name }: Call) {
  const form = await request.formData();
  const metadata = decode(Metadata, String(form.get("metadata")));
  const modules = [...form.keys()].filter((key) => key !== "metadata");
  const before: FakeScript = account.scripts.get(name) ?? { tags: [], migrations: [], metadata, modules, secrets: new Map(), workersDev: false };
  const { migrations } = metadata;

  refuseUpload(metadata, modules, before.migrationTag);
  account.scripts.set(name, {
    ...before,
    tags: metadata.tags ?? [],
    migrationTag: migrations?.new_tag ?? before.migrationTag,
    migrations: [...before.migrations, ...(migrations ? [migrations] : [])],
    metadata,
    modules,
    secrets: secretsAfter(metadata, before.secrets)
  });

  return { id: name, tag: `tag-${name}`, etag: "etag", has_assets: Boolean(metadata.assets), has_modules: true };
}

/** The Worker's secrets after an upload: the ones it kept, and the ones it sent. */
function secretsAfter(metadata: FakeScript["metadata"], before: Map<string, string>): Map<string, string> {
  const kept = metadata.keep_bindings?.includes("secret_text") ? before : undefined;
  const secrets = new Map(kept);

  for (const binding of metadata.bindings ?? []) if (binding.type === "secret_text") secrets.set(binding.name, binding.text ?? "");

  return secrets;
}

async function setWorkersDev(call: Call) {
  const script = scriptNamed(call);

  script.workersDev = decode(Type.Object({ enabled: Type.Boolean() }), await call.request.text()).enabled;

  return { enabled: script.workersDev, previews_enabled: false };
}

async function createBucket({ account, request }: Call) {
  const created = decode(Type.Object({ name: Type.String() }), await request.text()).name;

  account.buckets.set(created, new Set());

  return { name: created };
}

function deleteBucket(call: Call) {
  if (bucketNamed(call).size > 0) throw new Failure(409, 10008, "The bucket you tried to delete is not empty.");
  call.account.buckets.delete(call.name);

  return {};
}

function listObjects(call: Call) {
  const prefix = call.url.searchParams.get("prefix") ?? "";

  return [...bucketNamed(call)].flatMap((key) => (key.startsWith(prefix) ? [{ key }] : []));
}

async function putObject(call: Call) {
  bucketNamed(call).add(call.key);
  await call.request.arrayBuffer();

  return { key: call.key };
}

async function deleteObjects(call: Call) {
  const bucket = bucketNamed(call);

  for (const key of decode(Type.Array(Type.String()), await call.request.text())) bucket.delete(key);

  return [];
}

function organization({ account }: Call) {
  if (!account.team) throw new Failure(404, 9999, "access.api.error.not_found");

  return { auth_domain: account.team, name: account.team.split(".")[0] };
}

/** Creates the app, or with a name, replaces it. */
async function saveApp({ account, request, name }: Call) {
  const sent = decode(AppBody, await request.text());
  const id = name || `app-${account.apps.size + 1}`;
  const saved = { ...sent, id, aud: account.apps.get(id)?.aud ?? `aud-${id}` };

  if (sent.destinations.length === 0 || sent.policies.length === 0) throw new Failure(400, 12130, "An app needs destinations and policies");

  for (const tag of sent.tags ?? []) if (!account.tags.has(tag)) throw new Failure(400, 12135, `access.api.error.tag_not_found: ${tag}`);
  account.apps.set(id, saved);

  return app(saved);
}

function deleteApp({ account, name }: Call) {
  if (!account.apps.delete(name)) throw new Failure(404, 12130, "access.api.error.not_found");

  return { id: name };
}

/** The Durable Object namespaces the Workers' migrations made, as Cloudflare lists them. */
function namespaceList(account: FakeAccount) {
  return [...account.scripts].flatMap(([script, { migrations }]) => {
    const classes = new Set<string>();

    for (const step of migrations.flatMap((migration) => migration.steps)) {
      for (const made of [...(step.new_sqlite_classes ?? []), ...(step.new_classes ?? [])]) classes.add(made);

      for (const gone of step.deleted_classes ?? []) classes.delete(gone);
    }

    return [...classes].map((name) => ({ id: `ns-${script}-${name}`, class: name, name: `${script}_${name}`, script, use_sqlite: true }));
  });
}

function paid({ account }: Call): void {
  if (!account.paid) throw new Failure(403, 1000, "Containers are only available on the Workers Paid plan");
}

function containerApp(found: FakeContainerApp, accountId: string) {
  const { rollouts: _, listed: __, ...app } = found;

  return { ...app, account_id: accountId, instances: app.instances ?? 0, scheduling_policy: app.scheduling_policy ?? "default", created_at: "2026-01-01T00:00:00Z", version: found.rollouts.length + 1 };
}

function containerAppNamed(call: Call): FakeContainerApp {
  paid(call);
  const found = call.account.containerApps.get(call.name);

  if (!found) throw new Failure(404, 1609, "Container application not found");

  return found;
}

/** A new container app: its namespace must exist, have no app yet, and be a container class of its Worker. */
async function createContainerApp(call: Call) {
  paid(call);
  const sent = decode(ContainerAppBody, await call.request.text());
  const namespaceId = sent.durable_objects?.namespace_id;
  const namespace = namespaceList(call.account).find((each) => each.id === namespaceId);

  if (!namespace) throw new Failure(400, 1000, "Error checking the application durable object namespace");

  if ([...call.account.containerApps.values()].some((each) => each.durable_objects?.namespace_id === namespaceId))
    throw new Failure(400, 1608, "DURABLE_OBJECT_ALREADY_HAS_APPLICATION");

  if (!call.account.scripts.get(namespace.script)?.metadata.containers?.some((each) => each.class_name === namespace.class))
    throw new Failure(400, 1607, "DURABLE_OBJECT_NOT_CONTAINER_ENABLED");
  const created = { ...sent, id: `container-${call.account.containerApps.size + 1}`, rollouts: [] };

  call.account.containerApps.set(created.id, created);

  return containerApp(created, call.account.id);
}

/** Every route under /accounts/{id}, by method and path; `:name` is a Worker, bucket or app, `:key` an object. */
const ROUTES = new Map<string, Handler>([
  ["GET workers/subdomain", subdomain],
  [
    "PUT workers/subdomain",
    async (call) => {
      call.account.subdomain = decode(Type.Object({ subdomain: Type.String() }), await call.request.text()).subdomain;

      return subdomain(call);
    }
  ],
  ["POST workers/assets/upload", uploadAssets],
  ["GET workers/scripts", ({ account }) => [...account.scripts].map(([id, script]) => scriptItem(id, script))],
  ["GET workers/services/:name", service],
  ["PUT workers/scripts/:name", putScript],
  [
    "DELETE workers/scripts/:name",
    (call) => {
      scriptNamed(call);
      call.account.scripts.delete(call.name);

      return null;
    }
  ],
  ["POST workers/scripts/:name/assets-upload-session", assetSession],
  ["GET workers/scripts/:name/subdomain", (call) => ({ enabled: scriptNamed(call).workersDev, previews_enabled: false })],
  ["POST workers/scripts/:name/subdomain", setWorkersDev],
  ["GET workers/scripts/:name/settings", (call) => ({ bindings: scriptNamed(call).metadata.bindings ?? [] })],
  ["GET workers/scripts/:name/secrets", (call) => [...scriptNamed(call).secrets.keys()].map((secret) => ({ name: secret, type: "secret_text" }))],
  ["GET r2/buckets", ({ account }) => ({ buckets: [...account.buckets.keys()].map((bucket) => ({ name: bucket })) })],
  ["POST r2/buckets", createBucket],
  ["GET r2/buckets/:name", (call) => bucketNamed(call) && { name: call.name }],
  ["DELETE r2/buckets/:name", deleteBucket],
  ["GET r2/buckets/:name/objects", listObjects],
  ["PUT r2/buckets/:name/objects/:key", putObject],
  ["DELETE r2/buckets/:name/objects", deleteObjects],
  ["GET access/organizations", organization],
  ["GET access/tags", ({ account, url }) => new Page([...account.tags].map((name) => ({ name })), url)],
  [
    "POST access/tags",
    async ({ account, request }) => {
      const { name } = decode(Type.Object({ name: Type.String() }), await request.text());

      account.tags.add(name);

      return { name };
    }
  ],
  ["GET access/apps", ({ account, url }) => new Page([...account.apps.values()].map(app), url)],
  ["POST access/apps", saveApp],
  ["PUT access/apps/:name", saveApp],
  ["DELETE access/apps/:name", deleteApp],
  ["GET workers/durable_objects/namespaces", ({ account, url }) => new Page(namespaceList(account), url)],
  ["GET containers/me", (call) => (paid(call), { account_id: call.account.id })],
  [
    "GET containers/applications",
    (call) => (paid(call), [...call.account.containerApps.values()].map((each) => ({ ...containerApp(each, call.account.id), configuration: each.listed ?? each.configuration })))
  ],
  ["GET containers/applications/:name", (call) => containerApp(containerAppNamed(call), call.account.id)],
  ["POST containers/applications", createContainerApp],
  [
    "PATCH containers/applications/:name",
    async (call) => {
      const found = containerAppNamed(call);

      const sent = decode(Type.Object({ configuration: Type.Optional(Configuration), max_instances: Type.Optional(Type.Number()) }), await call.request.text());

      if (sent.configuration) found.configuration = sent.configuration;

      if (sent.max_instances !== undefined) found.max_instances = sent.max_instances;

      return containerApp(found, call.account.id);
    }
  ],
  [
    "POST containers/applications/:name/rollouts",
    async (call) => {
      const found = containerAppNamed(call);

      found.rollouts.push(decode(Type.Object({ target_configuration: Configuration }), await call.request.text()).target_configuration);

      return containerApp(found, call.account.id);
    }
  ],
  [
    "DELETE containers/applications/:name",
    (call) => {
      containerAppNamed(call);
      call.account.containerApps.delete(call.name);

      return {};
    }
  ],
  ["POST containers/registries/:name/credentials", (call) => (paid(call), { username: REGISTRY_LOGIN.username, password: REGISTRY_LOGIN.password })]
]);

/** The route's handler, by its exact path or with `:name` for the third part and `:key` for the fifth. */
function handlerFor(method: string, path: string[]): Handler {
  const named = path.map((part, index) => [part, part, ":name", part, ":key"][index] ?? part);
  const handler = ROUTES.get(`${method} ${path.join("/")}`) ?? ROUTES.get(`${method} ${named.join("/")}`);

  if (!handler) throw new Failure(404, 7003, `No route for ${method} ${path.join("/")}`);

  return handler;
}

/** Throws what Cloudflare answers a login that lacks the permission `path` needs. */
function refuseLogin(path: string[], authorization: string | null): void {
  if (path[0] === "access" && authorization === `Bearer ${WRANGLER_TOKEN}`) throw new Failure(403, 10001, "Method not allowed for this authentication scheme");

  if (path.join("/") === "access/organizations" && authorization === `Bearer ${NO_ORGANIZATION_TOKEN}`) throw new Failure(403, 10000, "Authentication error");
}

const RuleBody = Type.Object({
  name: Type.String(),
  enabled: Type.Boolean(),
  matchers: Type.Array(Type.Object({ type: Type.String(), field: Type.Optional(Type.String()), value: Type.Optional(Type.String()) })),
  actions: Type.Array(Type.Object({ type: Type.String(), value: Type.Optional(Type.Array(Type.String())) }))
});

/** A zone, as GET /zones lists it. */
function zoneItem(zone: FakeZone, account: FakeAccount) {
  const at = "2026-01-01T00:00:00Z";

  return {
    id: zone.id,
    name: zone.name,
    account: { id: account.id, name: account.name },
    activated_on: at,
    created_on: at,
    modified_on: at,
    development_mode: 0,
    meta: {},
    name_servers: [],
    original_dnshost: "",
    original_name_servers: [],
    original_registrar: "",
    owner: {},
    plan: {},
    status: "active"
  };
}

/** The zones API: listing zones, and a zone's Email Routing and its rules. */
async function zoneRoute(fake: FakeCloudflare, request: Request, url: URL, path: string[]): Promise<object | null> {
  const accounts = [...fake.accounts.values()];

  if (path.length === 0 && request.method === "GET") {
    const only = url.searchParams.get("account.id");
    const name = url.searchParams.get("name");

    return new Page(
      accounts
        .filter((account) => !only || account.id === only)
        .flatMap((account) => [...account.zones.values()].flatMap((zone) => (!name || zone.name === name ? [zoneItem(zone, account)] : []))),
      url
    );
  }

  const [zoneId, ...rest] = path;
  const account = accounts.find((each) => each.zones.has(zoneId ?? ""));
  const zone = account?.zones.get(zoneId ?? "");

  if (!account || !zone) throw new Failure(404, 7003, "Could not route to /zones/…, perhaps your object identifier is invalid?");
  fake.requests.push(`${request.method} zones/${zone.name}/${rest.join("/")}`);
  const call = `${request.method} ${rest.join("/")}`;

  if (call === "GET email/routing") return { id: zone.id, name: zone.name, enabled: zone.routing };

  if (call === "GET email/routing/rules") return new Page(zone.rules, url);

  if (call === "POST email/routing/rules") {
    const rule = { id: `rule-${zone.rules.length + 1}`, ...decode(RuleBody, await request.text()) };

    zone.rules.push(rule);

    return rule;
  }

  throw new Failure(404, 7003, `No route for ${call}`);
}

/** The route's result, or a Failure. */
async function route(fake: FakeCloudflare, request: Request): Promise<object | null> {
  const url = new URL(request.url);
  const [root, id, ...path] = url.pathname.split("/").filter(Boolean);

  if (root === "zones") return zoneRoute(fake, request, url, [id, ...path].filter((part): part is string => part !== undefined));

  if (root !== "accounts") throw new Failure(404, 7003, `No route for ${url.pathname}`);

  if (!id) return new Page([...fake.accounts.values()].map((account) => ({ id: account.id, name: account.name, type: "standard" })), url);
  const account = fake.accounts.get(id);

  if (!account) throw new Failure(404, 7003, "Could not route to /accounts/…, perhaps your object identifier is invalid?");
  fake.requests.push(`${request.method} ${path.join("/")}`);

  refuseLogin(path, request.headers.get("authorization"));

  return handlerFor(request.method, path)({ account, request, url, name: path[2] ?? "", key: decodeURIComponent(path[4] ?? "") });
}

/** The route's response, in Cloudflare's envelope. */
async function respond(fake: FakeCloudflare, request: Request) {
  try {
    const result = await route(fake, request);

    // A page carries its own result_info.
    return { status: 200, envelope: { success: true, errors: [], messages: [], ...(result instanceof Page ? result : { result }) } };
  } catch (error) {
    if (!(error instanceof Failure)) throw error;

    return { status: error.status, envelope: { success: false, errors: [{ code: error.code, message: error.message }], messages: [], result: null } };
  }
}

/** Serves a fake Cloudflare API on a free port. */
export async function fakeCloudflare(...accounts: FakeAccount[]): Promise<FakeCloudflare> {
  const server = createServer(async (message, response) => {
    const request = new Request(`http://fake${message.url}`, {
      method: message.method,
      headers: Object.entries(message.headers).flatMap(([header, value]): [string, string][] => (value === undefined ? [] : [[header, String(value)]])),
      body: message.method === "GET" || message.method === "HEAD" ? undefined : await body(message)
    });

    const { status, envelope } = await respond(fake, request);

    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(envelope));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!Value.Check(Type.Object({ port: Type.Number() }), address)) throw new Error("The fake Cloudflare isn't listening on a port");

  const fake: FakeCloudflare = {
    url: `http://127.0.0.1:${address.port}`,
    accounts: new Map(accounts.map((account) => [account.id, account])),
    requests: [],
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };

  return fake;
}
