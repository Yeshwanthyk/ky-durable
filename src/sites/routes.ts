import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { capped } from "../inbound/routes";
import {
  type DataCaller,
  type DataOp,
  hidden,
  LINK_TOKEN,
  MAX_ITEM_BYTES,
  META,
  metaOr,
  publicKey,
  type RouteMode,
  routeOr,
  ShareBody,
  SITE_ID,
  type SiteBucket,
  siteKey,
  type SiteObject
} from "./contract";
import { EMBED_HEAD } from "./embed-theme";
import { listSites } from "./sites";

export type SiteEnv = { readonly FILES: SiteBucket; readonly PiAgent: Env["PiAgent"]; readonly HOOK_LIMIT: Env["HOOK_LIMIT"] };

const agent = (env: SiteEnv) => env.PiAgent.getByName("me");

const TYPES = new Map([
  ["html", "text/html; charset=utf-8"],
  ["htm", "text/html; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["json", "application/json"],
  ["txt", "text/plain; charset=utf-8"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["ico", "image/x-icon"],
  ["woff2", "font/woff2"]
]);

const HEIGHT_REPORTER = `<script>(() => {
  let last = 0;
  const post = () => {
    const body = document.body;
    if (!body) return;
    const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().bottom + parseFloat(getComputedStyle(body).marginBottom)));
    if (height === last) return;
    last = height;
    parent.postMessage({ kySiteHeight: height }, "*");
  };
  new ResizeObserver(post).observe(document.documentElement);
  addEventListener("load", post);
  post();
})();</script>`;

const POLL_MS = 4_000;

/**
 * A living site's helper, first in each page so its own scripts find it: `ky.data` reads and writes the site's data at `base`,
 * a link's address (a sandboxed page sends no cookie), and the page polls the site's version while it's shown, reloading when
 * ky republishes it and telling `ky.data.onChange` listeners (and a `ky:data` event) when its data changes.
 */
const helper = (base: string, mode: RouteMode) => `<script>(() => {
  const base = ${JSON.stringify(base)};
  const seg = (part) => encodeURIComponent(String(part));
  const listeners = new Set();
  let known = null;
  const call = async (path, init) => {
    const response = await fetch(base + "_data" + path, { cache: "no-store", ...init });
    const body = await response.json().catch(() => ({}));
    if (response.status === 404 && init === undefined && String(body.error).startsWith("No item")) return { item: null };
    if (!response.ok) throw new Error(body.error || "ky couldn't reach the site's data (" + response.status + ")");
    if (known && body.version === known.data + 1) known.data = body.version;
    return body;
  };
  const item = (collection, key) => "/" + seg(collection) + "/" + seg(key);
  const json = { "Content-Type": "application/json" };
  const data = {
    collections: async () => (await call("/")).collections,
    list: async (collection) => (await call("/" + seg(collection))).items,
    get: async (collection, key) => (await call(item(collection, key))).item,
    put: async (collection, key, value) => (await call(item(collection, key), { method: "PUT", headers: json, body: JSON.stringify(value) })).item,
    remove: async (collection, key) => (await call(item(collection, key), { method: "DELETE" })).removed,
    onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  window.ky = Object.assign(window.ky || {}, { data, mode: ${JSON.stringify(mode === "owner" ? "edit" : mode)} });
  const check = async () => {
    try {
      const response = await fetch(base + "_version", { cache: "no-store" });
      if (response.ok) {
        const version = await response.json();
        if (known && version.published !== known.published) return location.reload();
        const changed = known !== null && version.data !== known.data;
        known = version;
        if (changed) {
          for (const listener of listeners) try { listener(); } catch {}
          dispatchEvent(new Event("ky:data"));
        }
      }
    } catch {}
    if (document.visibilityState === "visible") setTimeout(check, ${POLL_MS});
    else addEventListener("visibilitychange", check, { once: true });
  };
  check();
})();</script>`;

type Dressing = { readonly embed: boolean; readonly live?: { readonly base: string; readonly mode: RouteMode } };

const dressed = (html: string, { embed, live }: Dressing) => {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";

  return `${doctype}${embed ? EMBED_HEAD : ""}${live ? helper(live.base, live.mode) : ""}${html.slice(doctype.length)}${embed ? HEIGHT_REPORTER : ""}`;
};

const notFound = () => new Response("Not found\n", { status: 404 });

const OPEN = { "Access-Control-Allow-Origin": "*" };

const PREFLIGHT = { ...OPEN, "Access-Control-Allow-Methods": "GET, PUT, DELETE", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };

const answered = (status: number, body: Schema.Json, open: boolean) => Response.json(body, { status, headers: open ? { "Cache-Control": "no-store", ...OPEN } : { "Cache-Control": "no-store" } });

function unescaped(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function sitePath(rest: string): string | undefined {
  if (/%2f|%5c|\\/i.test(rest)) return undefined;
  const decoded = unescaped(rest.slice(1));

  if (decoded === undefined) return undefined;
  const path = decoded === "" || decoded.endsWith("/") ? `${decoded}index.html` : decoded;

  return path.split("/").includes("") || hidden(path) ? undefined : path;
}

const isApp = async (bucket: SiteBucket, id: string) => (await (await bucket.get(siteKey(id, META)))?.text().then(metaOr))?.app === true;

async function serve(request: Request, bucket: SiteBucket, id: string, rest: string, open: boolean, embed: boolean, live: (() => Promise<Dressing["live"]>) | undefined): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed\n", { status: 405 });
  const path = sitePath(rest);

  if (path === undefined) return notFound();

  if (request.method === "HEAD") {
    const head = await bucket.head(siteKey(id, path));

    return head ? new Response(null, { headers: headersFor(path, head, open) }) : notFound();
  }

  const object = await bucket.get(siteKey(id, path));

  if (!object) return notFound();
  const headers = headersFor(path, object, open);

  if (!headers.get("Content-Type")?.startsWith("text/html")) return new Response(object.body, { headers });
  const dressing: Dressing = { embed, live: live && (await isApp(bucket, id)) ? await live() : undefined };

  if (!dressing.embed && !dressing.live) return new Response(object.body, { headers });
  const html = new TextEncoder().encode(dressed(await object.text(), dressing));
  headers.set("Content-Length", String(html.byteLength));
  headers.set("ETag", `W/"${embed ? "embed-" : ""}${dressing.live ? "live-" : ""}${object.etag}"`);

  // A living page reloads when it's republished, so it never keeps a copy; the owner's carries their key.
  if (dressing.live) headers.set("Cache-Control", open ? "no-cache" : "private, no-store");

  return new Response(html, { headers });
}

function headersFor(path: string, object: SiteObject, open: boolean): Headers {
  const headers = new Headers({
    "Content-Type": TYPES.get(/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "") ?? "application/octet-stream",
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Length": String(object.size),
    ETag: object.httpEtag
  });

  if (open) {
    headers.set("Cache-Control", "public, max-age=60");
    headers.set("X-Robots-Tag", "noindex");
  }

  return headers;
}

const decodeItem = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** The data operation a request to `<site>/_data<rest>` asks for, or the response that turns it away. */
async function dataOp(request: Request, rest: string, open: boolean): Promise<DataOp | Response> {
  const parts = rest.split("/").slice(1);

  if (rest === "" || rest === "/") return request.method === "GET" ? { op: "collections" } : answered(405, { error: "Method not allowed" }, open);
  const [collection, key, ...more] = parts.map(unescaped);

  if (collection === undefined || more.length > 0 || parts.length > 2) return answered(404, { error: "Not found" }, open);

  if (key === undefined) return request.method === "GET" ? { op: "list", collection } : answered(405, { error: "Method not allowed" }, open);

  if (request.method === "GET") return { op: "get", collection, key };

  if (request.method === "DELETE") return { op: "remove", collection, key };

  if (request.method !== "PUT" && request.method !== "POST") return answered(405, { error: "Method not allowed" }, open);
  const text = Number(request.headers.get("Content-Length") ?? 0) > MAX_ITEM_BYTES * 2 ? null : await capped(request.body, MAX_ITEM_BYTES * 2);

  if (text === null) return answered(413, { error: `An item holds at most ${MAX_ITEM_BYTES / 1024} KB of JSON.` }, open);
  const value = decodeItem(text);

  return Option.isSome(value) ? { op: "put", collection, key, value: value.value } : answered(400, { error: "An item is a JSON value." }, open);
}

/** `_data` and `_version` under a site, for the owner signed in or a link, the only routes a link to the owner's key opens. */
async function siteApi(request: Request, env: SiteEnv, site: string, rest: string, caller: DataCaller): Promise<Response | undefined> {
  const open = caller.kind === "link";

  if (rest === "/_version") {
    if (request.method !== "GET") return answered(405, { error: "Method not allowed" }, open);
    const { published, data } = await agent(env).siteVersion(site);

    return answered(200, { published, data }, open);
  }

  if (rest !== "/_data" && !rest.startsWith("/_data/")) return undefined;
  const op = await dataOp(request, rest.slice("/_data".length), open);

  if (op instanceof Response) return op;

  if (open && (op.op === "put" || op.op === "remove")) {
    const address = request.headers.get("CF-Connecting-IP") ?? "unknown";

    if (!(await env.HOOK_LIMIT.limit({ key: `site:${address}` })).success) return answered(429, { error: "Too many changes; wait a minute." }, open);
  }

  const { status, body } = await agent(env).siteData(site, caller, op);

  return answered(status, body, open);
}

async function owners(request: Request, env: SiteEnv, url: URL): Promise<Response> {
  const [, id, token] = /^\/api\/sites(?:\/([0-9a-f]{32})\/links(?:\/([A-Za-z0-9_-]{22}))?)?$/.exec(url.pathname) ?? [];

  if (id === undefined) return url.pathname === "/api/sites" && request.method === "GET" ? Response.json(await listSites(env.FILES)) : new Response(null, { status: url.pathname === "/api/sites" ? 405 : 404 });

  if (token === undefined && request.method === "GET") {
    const listed = await agent(env).siteLinks(id);

    return "refused" in listed ? Response.json({ error: listed.refused }, { status: 404 }) : Response.json(listed);
  }

  if (token !== undefined) {
    if (request.method !== "DELETE") return new Response(null, { status: 405 });
    const done = await agent(env).siteRevoke(id, token);

    return "refused" in done ? Response.json({ error: done.refused }, { status: 404 }) : Response.json(done);
  }

  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body = Schema.decodeUnknownOption(Schema.fromJsonString(ShareBody))(await request.text());

  if (Option.isNone(body)) return Response.json({ error: "A link is { label?, mode?: view | edit }." }, { status: 400 });
  const made = await agent(env).siteShare(id, body.value.label ?? "", body.value.mode ?? "view");

  return "refused" in made ? Response.json({ error: made.refused }, { status: 400 }) : Response.json(made);
}

export function siteRoute(request: Request, env: SiteEnv, url: URL): Promise<Response> | undefined {
  if (url.pathname === "/api/sites" || url.pathname.startsWith("/api/sites/")) return owners(request, env, url);

  if (!url.pathname.startsWith("/s/")) return undefined;
  const [, id, rest] = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];

  if (!id || !SITE_ID.test(id)) return Promise.resolve(notFound());

  if (rest === undefined) return Promise.resolve(Response.redirect(new URL(`/s/${id}/`, url).toString(), 301));

  return (async () => {
    const api = await siteApi(request, env, id, rest, { kind: "owner" });

    if (api) return api;

    const live = async () => {
      const key = await agent(env).siteOwnerKey(id);

      return key === null ? undefined : { base: `/p/${key}/`, mode: "owner" as const };
    };

    return serve(request, env.FILES, id, rest, false, url.searchParams.has("embed"), live);
  })();
}

export function publicSiteRoute(request: Request, env: SiteEnv, url: URL): Promise<Response> | undefined {
  if (!url.pathname.startsWith("/p/")) return undefined;
  const [, token, rest] = /^\/p\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];

  if (!token || !LINK_TOKEN.test(token)) return Promise.resolve(notFound());

  if (rest === undefined) return Promise.resolve(Response.redirect(new URL(`/p/${token}/`, url).toString(), 301));

  if (request.method === "OPTIONS") return Promise.resolve(new Response(null, { status: 204, headers: PREFLIGHT }));

  return (async () => {
    const route = routeOr((await (await env.FILES.get(publicKey(token)))?.text()) ?? "");

    if (!route) return rest.startsWith("/_") ? answered(404, { error: "No such link." }, true) : notFound();
    const api = await siteApi(request, env, route.site, rest, { kind: "link", token });

    if (api) return api;

    if (route.mode === "owner") return notFound();

    return serve(request, env.FILES, route.site, rest, true, false, async () => ({ base: `/p/${token}/`, mode: route.mode }));
  })();
}
