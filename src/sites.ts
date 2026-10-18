import type { Workspace } from "@cloudflare/computer";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import Type from "typebox";
import { parseOr } from "./core/decode";

/**
 * site: the agent of a chat with the user publishes a small static site, one
 * HTML page or a workspace folder, at `/s/<id>/`, behind Access like the rest
 * of ky (src/site-routes.ts serves it). On the user's request it is also
 * public at `/p/<token>/`, with no sign-in, until it is made private again.
 *
 * R2 holds all of it, so the Worker serves without the agent: the files at
 * `sites/<id>/<path>`, the title, creation time and public token at
 * `sites/<id>/.site`, and `sites-public/<token>` naming the id while public.
 */

const SITE = "site";

const MAX_FILES = 200;

const MAX_BYTES = 10 * 1024 * 1024;

const MAX_SITES = 50;

/** The object that holds a site's title, creation time and public token; never served. */
export const META = ".site";

/** A site's id: 32 hex characters, as a file's. */
export const SITE_ID = /^[0-9a-f]{32}$/;

export const siteKey = (id: string, path: string) => `sites/${id}/${path}`;

export const publicKey = (token: string) => `sites-public/${token}`;

const SiteMeta = Type.Object({ title: Type.String(), created: Type.Number(), token: Type.Optional(Type.String()) });

type SiteMeta = Type.Static<typeof SiteMeta>;

const SiteArgs = Type.Object({
  action: Type.Union([Type.Literal("publish"), Type.Literal("list"), Type.Literal("make_public"), Type.Literal("make_private"), Type.Literal("delete")]),
  id: Type.Optional(Type.String({ description: "The site, for make_public, make_private and delete; for publish, the site whose files to replace." })),
  title: Type.Optional(Type.String({ description: "publish: the site's title." })),
  html: Type.Optional(Type.String({ description: "publish: one HTML page, served as the site's index.html." })),
  dir: Type.Optional(Type.String({ description: "publish: a workspace folder, such as /workspace/site, served with its index.html at the root." }))
});

const reply = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });

async function meta(bucket: R2Bucket, id: string): Promise<SiteMeta | undefined> {
  const object = await bucket.get(siteKey(id, META));

  return object ? parseOr(SiteMeta, await object.text(), undefined) : undefined;
}

const putMeta = (bucket: R2Bucket, id: string, value: SiteMeta) => bucket.put(siteKey(id, META), JSON.stringify(value));

/** Every key under the site's prefix, its metadata included. */
async function keys(bucket: R2Bucket, id: string): Promise<string[]> {
  return (await bucket.list({ prefix: siteKey(id, "") })).objects.map((object) => object.key);
}

/** Put `files` as the site's, then delete those it had before and lacks now. */
async function store(bucket: R2Bucket, id: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  for (const [path, body] of files) await bucket.put(siteKey(id, path), body);
  const kept = new Set([...files.keys(), META].map((path) => siteKey(id, path)));
  const stale = (await keys(bucket, id)).filter((key) => !kept.has(key));

  if (stale.length > 0) await bucket.delete(stale);
}

/** A new public token: 128 random bits, base64url. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** A site's files by their path in it, or why they can't be one. */
type Gathered = { readonly files: ReadonlyMap<string, Uint8Array> } | { readonly refused: string };

type SiteArgs = Type.Static<typeof SiteArgs>;

/** The files of the folder `dir`, by their path under it. */
async function folder(workspace: Workspace, dir: string): Promise<Gathered> {
  const root = dir.replace(/\/+$/, "");
  let found;

  try {
    found = (await workspace.fs.find(root, "**", { limit: MAX_FILES + 1 })).filter((entry) => entry.type === "file");
  } catch (error) {
    return { refused: `Couldn't read ${dir}: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (found.length > MAX_FILES) return { refused: `Not published: a site holds at most ${MAX_FILES} files, and ${dir} has more.` };
  const files = new Map<string, Uint8Array>();

  for (const entry of found) {
    const path = entry.path.startsWith(`${root}/`) ? entry.path.slice(root.length + 1) : entry.path.replace(/^\/+/, "");

    files.set(path, new Uint8Array(await new Response(await workspace.fs.readFile(`${root}/${path}`)).arrayBuffer()));
  }

  return { files };
}

/** The files publish names, the page `html` or the folder `dir`, within the caps. */
async function gather(workspace: Workspace, { html, dir }: SiteArgs): Promise<Gathered> {
  if ((html === undefined) === (dir === undefined)) return { refused: "Not published: give either html or dir." };
  const gathered = html === undefined ? await folder(workspace, dir ?? "") : { files: new Map([["index.html", new TextEncoder().encode(html)]]) };

  if ("refused" in gathered) return gathered;
  const { files } = gathered;

  if (files.size === 0) return { refused: `Not published: ${dir} has no files.` };

  if (files.has(META)) return { refused: `Not published: a site can't hold a file named ${META}.` };
  const bytes = [...files.values()].reduce((total, body) => total + body.byteLength, 0);

  if (bytes > MAX_BYTES) return { refused: `Not published: a site holds at most ${MAX_BYTES / 1024 / 1024} MB, and this is ${(bytes / 1024 / 1024).toFixed(1)} MB.` };

  return gathered;
}

/** The site tool; only a chat with the user may call it, as `uiExtension`'s. `origin` is ky's address, once a browser opened it. */
export function siteExtension(chat: (session: string) => boolean, bucket: R2Bucket, workspace: Workspace, origin: () => string | null): Extension {
  const privateUrl = (id: string) => `${origin() ?? ""}/s/${id}/`;
  const publicUrl = (token: string) => `${origin() ?? ""}/p/${token}/`;
  const ids = async () => (await bucket.list({ prefix: "sites/", delimiter: "/" })).delimitedPrefixes.map((prefix) => prefix.slice("sites/".length, -1));

  /** The site `id`, when there is one. */
  const find = async (id: string) => (SITE_ID.test(id) ? meta(bucket, id) : undefined);

  /** The site publish writes: `id`'s, which must exist, or a new one within the cap. */
  async function target(id: string | undefined): Promise<{ id: string; was?: SiteMeta } | { refused: string }> {
    if (id !== undefined) {
      const was = await find(id);

      return was ? { id, was } : { refused: `No site ${id}.` };
    }

    return (await ids()).length >= MAX_SITES ? { refused: `Not published: ky keeps at most ${MAX_SITES} sites. Delete one first.` } : { id: crypto.randomUUID().replaceAll("-", "") };
  }

  async function publish(args: SiteArgs) {
    const to = await target(args.id);

    if ("refused" in to) return reply(to.refused, true);
    const gathered = await gather(workspace, args);

    if ("refused" in gathered) return reply(gathered.refused, true);
    await store(bucket, to.id, gathered.files);
    await putMeta(bucket, to.id, { created: Date.now(), ...to.was, title: args.title ?? to.was?.title ?? "Untitled" });

    return reply(`Published at ${privateUrl(to.id)} (id ${to.id}, ${gathered.files.size} files), for the signed-in user only.`);
  }

  async function list() {
    const lines = [];

    for (const id of await ids()) {
      const site = await meta(bucket, id);

      if (site) lines.push(`- ${id} "${site.title}" ${privateUrl(id)}${site.token === undefined ? "" : `, public at ${publicUrl(site.token)}`}`);
    }

    return reply(lines.length === 0 ? "No sites." : lines.join("\n"));
  }

  /**
   * make_public keeps a public site's token; make_private and delete drop it, so it never works again. The
   * token is in the metadata before its public object and outlives it, so a call cut off between the two
   * never leaves a public object the metadata doesn't name, and a token whose object is gone is never reissued.
   */
  async function change(action: "make_public" | "make_private" | "delete", id: string) {
    const site = await find(id);

    if (!site) return reply(`No site ${id}.`, true);

    if (action === "make_public") {
      const token = site.token !== undefined && (await bucket.head(publicKey(site.token))) ? site.token : newToken();
      await putMeta(bucket, id, { ...site, token });
      await bucket.put(publicKey(token), id);

      return reply(`Public at ${publicUrl(token)}: anyone with the link can open it until it's made private.`);
    }

    if (site.token !== undefined) await bucket.delete(publicKey(site.token));

    if (action === "make_private") {
      await putMeta(bucket, id, { title: site.title, created: site.created });

      return reply(`Private again: its public address no longer works. It stays at ${privateUrl(id)}.`);
    }

    await bucket.delete(await keys(bucket, id));

    return reply(`Deleted the site ${id}.`);
  }

  return defineExtension({
    name: SITE,
    tools: [
      defineTool({
        name: SITE,
        description:
          "Publish a small static site from HTML you write (html) or a workspace folder of HTML, CSS, JS and images (dir), served at a private ky address " +
          "only the user can open. publish with an id replaces that site's files. list shows the sites and their addresses. make_public also serves a site " +
          "at a public address anyone with the link can open: do it only when the user asks for a public link. make_private ends the public address for good; " +
          `delete removes the site. At most ${MAX_FILES} files and ${MAX_BYTES / 1024 / 1024} MB a site, ${MAX_SITES} sites.`,
        parameters: SiteArgs,
        replay: "unsafe",
        execute: async (args, api) => {
          if (!chat(String(api.conversationId))) return reply("Not done: only a chat with the user may publish sites.", true);

          if (args.action === "publish") return publish(args);

          return args.action === "list" ? list() : change(args.action, args.id ?? "");
        }
      })
    ]
  });
}
