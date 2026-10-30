// ky's service worker. On install it caches the whole build: the page and every
// file the build has (sw-precache.ts lists them below), so ky starts offline with
// any part of it, the diff viewer and code highlighting included, not only what
// was already visited. Each build has its own cache, named by its version; once
// a new build's worker takes over, the old build's cache goes.
//
// Built files under /assets/ are named by their content hash, so a cached copy
// is right forever: they come from the cache without a round trip through
// Access and the Worker's check. The page itself comes from the network, so a
// deploy shows at once, and from the cache only when the network is gone, where
// the view cache paints the last chat. The other files (icons, the manifest)
// are named the same in every build, so they too come from the network first.
// Access's own pages (its login redirect, and /cdn-cgi/access/ on ky's address)
// are never cached: only what answers 200 without a redirect is.
//
// It also shows what ky posts unasked as notifications (src/push.ts), and a
// click on one opens its chat, in a ky window already open when there is one.

// The build's version and files; sw-precache.ts fills this line in at build. Under Vite's dev server it stays empty.
const BUILD = { version: "dev", files: [] };

const CACHE = `ky-${BUILD.version}`;

/** The app's page, cached under one key: every address of ky opens it. */
const SHELL = "/";

const FILES = new Set(BUILD.files);

/** How many files install fetches at once. */
const PARALLEL = 8;

/** The cache keeps only what is the app: a redirect is to Access's login, and an error is no file. */
const usable = (response) => response.ok && !response.redirected;

class Unreachable extends Error {}

/**
 * Fetch one file for the cache. A redirect (Access wants a sign-in) or a failed fetch (offline) is
 * Unreachable: the whole install waits for a better moment. An HTTP error is that file's alone; it
 * is tried once more.
 */
async function download(url) {
  // Hashed files are the same forever; the rest are checked with the server past the HTTP cache.
  const init = { cache: url.startsWith("/assets/") ? "default" : "no-cache" };

  const once = async () => {
    // Access's login is on the team's own domain: following its redirect fails here, as a cross-origin fetch.
    const response = await fetch(url, init).catch(() => {
      throw new Unreachable(`${url} could not be fetched`);
    });

    if (response.redirected) throw new Unreachable(`${url} redirected`);

    return response;
  };

  const first = await once();

  return first.ok ? first : once();
}

// Install fails, and the old worker keeps serving with its complete cache, when ky can't be reached
// cleanly: offline, or signed out of Access, which redirects. The browser tries again at its next update
// check, keeping what this attempt cached. A file that answers with an HTTP error twice doesn't fail it:
// that file is fetched when first used, as before, so one bad file never keeps a build from installing.
async function precache() {
  // Under Vite's dev server there is no build to cache; the page still is, as it is fetched.
  if (BUILD.version === "dev") return;
  const cache = await caches.open(CACHE);
  const shell = await download(SHELL);

  if (!usable(shell)) throw new Unreachable(`${SHELL} answered ${shell.status}`);
  await cache.put(SHELL, shell);

  // A hashed file an older build cached is this build's too: it is copied, not downloaded again.
  const older = (await caches.keys()).filter((name) => name !== CACHE);
  const queue = [...BUILD.files];

  const next = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (await cache.match(url)) continue;
      const kept = url.startsWith("/assets/") ? await firstMatch(older, url) : undefined;
      const response = kept ?? (await download(url));

      if (usable(response)) await cache.put(url, response);
    }
  };

  await Promise.all(Array.from({ length: PARALLEL }, next));
}

async function firstMatch(names, url) {
  for (const name of names) {
    const hit = await (await caches.open(name)).match(url);

    if (hit) return hit;
  }

  return undefined;
}

self.addEventListener("install", (event) => event.waitUntil(precache().then(() => self.skipWaiting())));

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Older builds' caches, and those of the worker before builds had their own (ky-assets-v1, ky-pages-v1).
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }

      await self.clients.claim();
    })()
  );
});

/** How the worker answers a GET for ky's own address, outside Access's /cdn-cgi/; undefined leaves it to the network. */
function answer(request, url) {
  if (url.pathname.startsWith("/assets/")) return asset(request);

  if (request.mode === "navigate") return fresh(request, SHELL);

  return FILES.has(url.pathname) ? fresh(request, url.pathname) : undefined;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const ours = request.method === "GET" && url.origin === self.location.origin && !url.pathname.startsWith("/cdn-cgi/");
  const response = ours ? answer(request, url) : undefined;

  if (response) event.respondWith(response);
});

async function asset(request) {
  const cache = await caches.open(CACHE);
  // Install cached these from its own fetches, without the Origin header the page's module scripts carry: a
  // `Vary: Origin` on them would make every one a miss.
  const hit = await cache.match(request, { ignoreVary: true });

  if (hit) return hit;
  const response = await fetch(request);

  if (usable(response)) await cache.put(request, response.clone());

  return response;
}

/** From the network, kept in the cache under `key`; from the cache only when the network is gone. */
async function fresh(request, key) {
  const cache = await caches.open(CACHE);

  try {
    const response = await fetch(request);

    if (usable(response)) await cache.put(key, response.clone());

    return response;
  } catch (error) {
    const kept = await cache.match(key);

    if (kept) return kept;
    throw error;
  }
}

self.addEventListener("push", (event) => {
  // src/push/push.ts sends lines: the title, the chat's address, then the text. Every push shows a notification,
  // even one that can't be read: Safari takes the subscription away from a page whose pushes show nothing.
  let lines = [];

  try {
    lines = (event.data?.text() ?? "").split("\n");
  } catch {
    // Shown as ky's, opening the main chat.
  }

  const [title, url, ...text] = lines;

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title || "ky", { body: text.join("\n"), icon: "/icons/icon-192.png", data: { url: url || "/" } });
      await badge(true);
    })()
  );
});

// The browser made this device's subscription again, or dropped it: make it again with ky's key. The page tells ky
// the new endpoint when it next opens (src/ui/Proactivity.tsx usePushUpkeep).
self.addEventListener("pushsubscriptionchange", (event) => {
  const key = event.oldSubscription?.options.applicationServerKey;

  if (event.newSubscription || !key) return;
  event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).catch(() => {}));
});

// The app icon's badge counts ky's notifications in the tray, recounted as each is shown, tapped or swiped away.
// Opening ky closes them and clears it (src/client.tsx). A browser that can't list them gets a plain dot for a push,
// which is told apart from an empty tray by `justShown`.
async function badge(justShown = false) {
  if (!("setAppBadge" in navigator)) return;
  const count = (await self.registration.getNotifications()).length;

  if (count > 0) await navigator.setAppBadge(count).catch(() => {});
  else if (justShown) await navigator.setAppBadge().catch(() => {});
  else await navigator.clearAppBadge().catch(() => {});
}

self.addEventListener("notificationclose", (event) => event.waitUntil(badge()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin);

  event.waitUntil(
    (async () => {
      await badge();
      const windows = await self.clients.matchAll({ type: "window" });
      const open = windows.find((each) => new URL(each.url).origin === self.location.origin);

      if (!open) return self.clients.openWindow(url.href);
      // An open ky switches to the chat itself (src/ui/use-session-route.ts), without a reload.
      open.postMessage({ type: "open-chat", search: url.search });

      return open.focus();
    })()
  );
});
