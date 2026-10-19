import { hidden, publicKey, SITE_ID, siteKey } from "./sites";

/**
 * The sites the site tool publishes (src/sites.ts), served from R2: `/s/<id>/` after the user's sign-in,
 * and `/p/<token>/` signed out while the site is public. A site's page runs sandboxed in an opaque origin,
 * so its script can't use the user's ky session.
 */

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

/**
 * What a page opened with `?embed` (a card's page block, src/ui/Blocks.tsx) runs after its own HTML: it posts
 * its height to the chat, which sizes the frame to it. Only when it changes, so a page that fills its frame
 * settles once the chat's cap is reached.
 */
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

const notFound = () => new Response("Not found\n", { status: 404 });

function unescaped(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** The site path `rest` (after `/s/<id>`) names; undefined for traversal, an encoded slash, or a hidden path such as the metadata. */
function sitePath(rest: string): string | undefined {
  if (/%2f|%5c|\\/i.test(rest)) return undefined;
  const decoded = unescaped(rest.slice(1));

  if (decoded === undefined) return undefined;
  const path = decoded === "" || decoded.endsWith("/") ? `${decoded}index.html` : decoded;

  return path.split("/").includes("") || hidden(path) ? undefined : path;
}

async function serve(request: Request, env: Env, id: string, rest: string, open: boolean, embed = false): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed\n", { status: 405 });
  const path = sitePath(rest);

  if (path === undefined) return notFound();

  if (request.method === "HEAD") {
    const head = await env.FILES.head(siteKey(id, path));

    return head ? new Response(null, { headers: headersFor(path, head, open) }) : notFound();
  }

  const object = await env.FILES.get(siteKey(id, path));

  if (!object) return notFound();
  const headers = headersFor(path, object, open);

  if (!embed || !headers.get("Content-Type")?.startsWith("text/html")) return new Response(object.body, { headers });
  const html = new TextEncoder().encode(`${await object.text()}${HEIGHT_REPORTER}`);
  headers.set("Content-Length", String(html.byteLength));
  headers.set("ETag", `W/"embed-${object.etag}"`);

  return new Response(html, { headers });
}

/** A site file's headers: its type by the last segment's extension, size and ETag, the sandbox, and for a public site, a short cache. */
function headersFor(path: string, object: R2Object, open: boolean): Headers {
  const headers = new Headers({
    "Content-Type": TYPES.get(/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "") ?? "application/octet-stream",
    // No allow-same-origin: the page's script runs in an opaque origin, away from the user's session.
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

/** A site at `/s/<id>/`, after the user's sign-in; undefined for any other path. With `?embed`, its pages report their height. */
export function siteRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  if (!url.pathname.startsWith("/s/")) return undefined;
  const [, id, rest] = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname) ?? [];

  if (!id || !SITE_ID.test(id)) return Promise.resolve(notFound());

  if (rest === undefined) return Promise.resolve(Response.redirect(new URL(`/s/${id}/`, url).toString(), 301));

  return serve(request, env, id, rest, false, url.searchParams.has("embed"));
}

/** A public site at `/p/<token>/`, signed out; undefined for any other path. */
export function publicSiteRoute(request: Request, env: Env, url: URL): Promise<Response> | undefined {
  if (!url.pathname.startsWith("/p/")) return undefined;
  const [, token, rest] = /^\/p\/([A-Za-z0-9_-]{22})(\/.*)?$/.exec(url.pathname) ?? [];

  if (!token) return Promise.resolve(notFound());

  if (rest === undefined) return Promise.resolve(Response.redirect(new URL(`/p/${token}/`, url).toString(), 301));

  return (async () => {
    const id = (await (await env.FILES.get(publicKey(token)))?.text()) ?? "";

    return SITE_ID.test(id) ? serve(request, env, id, rest, true) : notFound();
  })();
}
