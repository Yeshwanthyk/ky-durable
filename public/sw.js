// ky's service worker. Built files under /assets/ are named by their content
// hash, so a cached copy is right forever: they come from the cache without
// a round trip through Access and the Worker's check. The page itself comes
// from the network, so a deploy shows at once, and from the cache only when
// the network is gone, where the view cache paints the last chat. Access's own
// pages (its login redirect, and /cdn-cgi/access/ on ky's address) are never
// cached: only the app's page is.
//
// It also shows what ky posts unasked as notifications (src/push.ts), and a
// click on one opens its chat, in a ky window already open when there is one.

const ASSETS = "ky-assets-v1";

const PAGES = "ky-pages-v1";

/** An asset not fetched again in this long goes at the next prune; a deploy leaves old ones behind. */
const ASSET_DAYS = 30;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([ASSETS, PAGES]);

      for (const name of await caches.keys()) {
        if (!keep.has(name)) await caches.delete(name);
      }

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/cdn-cgi/")) return;

  if (url.pathname.startsWith("/assets/")) event.respondWith(asset(request));
  else if (request.mode === "navigate") event.respondWith(page(request, event));
});

async function asset(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);

  if (hit) return hit;
  const response = await fetch(request);

  if (response.ok && !response.redirected) await cache.put(request, response.clone());

  return response;
}

async function page(request, event) {
  const cache = await caches.open(PAGES);

  try {
    const response = await fetch(request);

    // A redirect is to Access's login; that is never the app to fall back to.
    if (response.ok && !response.redirected) {
      await cache.put("/", response.clone());
      event.waitUntil(prune());
    }

    return response;
  } catch (error) {
    const shell = await cache.match("/");

    if (shell) return shell;
    throw error;
  }
}

async function prune() {
  const cache = await caches.open(ASSETS);
  const oldest = Date.now() - ASSET_DAYS * 24 * 60 * 60 * 1000;

  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    const fetched = Date.parse(response?.headers.get("Date") ?? "");

    if (!Number.isNaN(fetched) && fetched < oldest) await cache.delete(request);
  }
}

self.addEventListener("push", (event) => {
  // src/push.ts sends lines: the title, the chat's address, then the text.
  const [title = "ky", url = "/", ...text] = (event.data?.text() ?? "").split("\n");

  event.waitUntil(self.registration.showNotification(title, { body: text.join("\n"), icon: "/icons/icon-192.png", data: { url } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window" });
      const open = windows.find((each) => new URL(each.url).origin === self.location.origin);

      if (!open) return self.clients.openWindow(url.href);
      // An open ky switches to the chat itself (src/ui/use-session-route.ts), without a reload.
      open.postMessage({ type: "open-chat", search: url.search });

      return open.focus();
    })()
  );
});
