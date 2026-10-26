import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  HtmlOrDir,
  MAX_BYTES,
  MAX_FILES,
  MAX_SITES,
  META,
  metaOr,
  NoFiles,
  NoSite,
  NotAChat,
  NotAFolder,
  publicKey,
  SITE_ID,
  type SiteArgs,
  type SiteFiles,
  siteKey,
  type SiteMeta,
  type SiteRow,
  hidden,
  TooBig,
  TooManyFiles,
  TooManySites,
  Unreadable
} from "./contract";

const PAGE = 500;

export type SiteHost = { readonly bucket: R2Bucket; readonly files: SiteFiles; readonly origin: () => string | null };

async function meta(bucket: R2Bucket, id: string): Promise<SiteMeta | undefined> {
  const object = await bucket.get(siteKey(id, META));

  return object ? metaOr(await object.text()) : undefined;
}

const siteIds = async (bucket: R2Bucket) => (await bucket.list({ prefix: "sites/", delimiter: "/" })).delimitedPrefixes.map((prefix) => prefix.slice("sites/".length, -1));

async function stored(bucket: R2Bucket): Promise<Array<{ id: string; site: SiteMeta }>> {
  const all = [];

  for (const id of await siteIds(bucket)) {
    const site = await meta(bucket, id);

    if (site) all.push({ id, site });
  }

  return all;
}

export async function listSites(bucket: R2Bucket): Promise<SiteRow[]> {
  return (await stored(bucket)).map(({ id, site }) => ({ id, title: site.title, created: site.created, public: site.token !== undefined })).sort((a, b) => b.created - a.created);
}

const putMeta = (bucket: R2Bucket, id: string, value: SiteMeta) => bucket.put(siteKey(id, META), JSON.stringify(value));

async function keys(bucket: R2Bucket, id: string): Promise<string[]> {
  return (await bucket.list({ prefix: siteKey(id, "") })).objects.map((object) => object.key);
}

async function store(bucket: R2Bucket, id: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  for (const [path, body] of files) await bucket.put(siteKey(id, path), body);
  const kept = new Set([...files.keys(), META].map((path) => siteKey(id, path)));
  const stale = (await keys(bucket, id)).filter((key) => !kept.has(key));

  if (stale.length > 0) await bucket.delete(stale);
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function canonical(dir: string): string | undefined {
  const parts = dir.split("/").filter((part) => part !== "" && part !== ".");

  return parts.length === 0 || parts.includes("..") ? undefined : `/${parts.join("/")}`;
}

async function listed(files: SiteFiles, root: string): Promise<string[]> {
  const paths: string[] = [];
  const prefix = `${root}/`;

  for (let offset = 0; paths.length <= MAX_FILES; offset += PAGE) {
    const page = await files.find(root, "**", { limit: PAGE, offset, exclude: ["**/.*"] });

    for (const entry of page) {
      const path = entry.path.slice(prefix.length);

      if (entry.type === "file" && entry.path.startsWith(prefix) && !hidden(path)) paths.push(path);
    }

    if (page.length < PAGE) break;
  }

  return paths;
}

const reading = <A>(dir: string, read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: (error) => new Unreadable({ dir, reason: error instanceof Error ? error.message : String(error) }) });

const folder = (files: SiteFiles, dir: string) =>
  Effect.gen(function* () {
    const root = canonical(dir);

    if (root === undefined) return yield* new NotAFolder({ dir });
    const paths = yield* reading(dir, () => listed(files, root));

    if (paths.length === 0) return yield* new NoFiles({ dir });

    if (paths.length > MAX_FILES) return yield* new TooManyFiles({ dir });
    let bytes = 0;

    for (const path of paths) bytes += (yield* reading(dir, () => files.stat(`${root}/${path}`))).size;

    if (bytes > MAX_BYTES) return yield* new TooBig({ bytes });
    const read = new Map<string, Uint8Array>();

    for (const path of paths) read.set(path, yield* reading(dir, async () => new Uint8Array(await new Response(await files.readFile(`${root}/${path}`)).arrayBuffer())));

    return read;
  });

const gather = (files: SiteFiles, { html, dir }: SiteArgs) =>
  Effect.gen(function* () {
    if ((html === undefined) === (dir === undefined)) return yield* new HtmlOrDir();

    if (html === undefined) return yield* folder(files, dir ?? "");
    const page = new TextEncoder().encode(html);

    if (page.byteLength > MAX_BYTES) return yield* new TooBig({ bytes: page.byteLength });

    return new Map([["index.html", page]]);
  });

const find = (bucket: R2Bucket, id: string) =>
  Effect.gen(function* () {
    const site = SITE_ID.test(id) ? yield* Effect.promise(() => meta(bucket, id)) : undefined;

    return site ?? (yield* new NoSite({ id }));
  });

const target = (bucket: R2Bucket, id: string | undefined) =>
  Effect.gen(function* () {
    if (id !== undefined) return { id, was: yield* find(bucket, id) };

    if ((yield* Effect.promise(() => siteIds(bucket))).length >= MAX_SITES) return yield* new TooManySites();

    return { id: crypto.randomUUID().replaceAll("-", ""), was: undefined };
  });

const addresses = (origin: () => string | null) => ({
  private: (id: string) => `${origin() ?? ""}/s/${id}/`,
  public: (token: string) => `${origin() ?? ""}/p/${token}/`
});

const publish = ({ bucket, files, origin }: SiteHost, args: SiteArgs) =>
  Effect.gen(function* () {
    const to = yield* target(bucket, args.id);
    const gathered = yield* gather(files, args);
    const created = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() => putMeta(bucket, to.id, { created, ...to.was, title: args.title ?? to.was?.title ?? "Untitled" }));
    yield* Effect.promise(() => store(bucket, to.id, gathered));

    return `Published at ${addresses(origin).private(to.id)} (id ${to.id}, ${gathered.size} files), for the signed-in user only.`;
  });

const list = ({ bucket, origin }: SiteHost) =>
  Effect.promise(async () => {
    const at = addresses(origin);
    const lines = (await stored(bucket)).map(({ id, site }) => `- ${id} "${site.title}" ${at.private(id)}${site.token === undefined ? "" : `, public at ${at.public(site.token)}`}`);

    return lines.length === 0 ? "No sites." : lines.join("\n");
  });

const makePublic = ({ bucket, origin }: SiteHost, id: string) =>
  Effect.gen(function* () {
    const site = yield* find(bucket, id);
    const token = yield* Effect.promise(async () => (site.token !== undefined && (await bucket.head(publicKey(site.token))) ? site.token : newToken()));
    yield* Effect.promise(() => putMeta(bucket, id, { ...site, token }));
    yield* Effect.promise(() => bucket.put(publicKey(token), id));

    return `Public at ${addresses(origin).public(token)}: anyone with the link can open it until it's made private.`;
  });

const makePrivate = ({ bucket, origin }: SiteHost, id: string) =>
  Effect.gen(function* () {
    const site = yield* find(bucket, id);
    const token = site.token;

    if (token !== undefined) yield* Effect.promise(() => bucket.delete(publicKey(token)));
    yield* Effect.promise(() => putMeta(bucket, id, { title: site.title, created: site.created }));

    return `Private again: its public address no longer works. It stays at ${addresses(origin).private(id)}.`;
  });

const remove = ({ bucket }: SiteHost, id: string) =>
  Effect.gen(function* () {
    const all = SITE_ID.test(id) ? yield* Effect.promise(() => keys(bucket, id)) : [];

    if (all.length === 0) return yield* new NoSite({ id });
    const token = (yield* Effect.promise(() => meta(bucket, id)))?.token;

    if (token !== undefined) yield* Effect.promise(() => bucket.delete(publicKey(token)));
    yield* Effect.promise(() => bucket.delete(all));

    return `Deleted the site ${id}.`;
  });

export const act = (host: SiteHost, args: SiteArgs, chat: boolean) =>
  Effect.gen(function* () {
    if (!chat) return yield* new NotAChat();

    if (args.action === "publish") return { text: yield* publish(host, args) };

    if (args.action === "list") return { text: yield* list(host) };

    if (args.action === "make_public") return { text: yield* makePublic(host, args.id ?? "") };

    if (args.action === "make_private") return { text: yield* makePrivate(host, args.id ?? "") };

    return { text: yield* remove(host, args.id ?? "") };
  });
