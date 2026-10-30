import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { accessCookie, ENDED } from "../../src/tests/fake-access.ts";
import { precacheList, writePrecache } from "../../sw-precache.ts";
import { machine, pairingCode, type Runner } from "../harness/runner.ts";
import { buildStack, REPO, type Stack, startStack } from "../harness/stack.ts";

/**
 * ky as an installed PWA starts it with no network: built, served as production serves it, with
 * public/sw.js registered by the app and caching the whole build on install. The rest of the suite
 * runs on Vite's dev server, where the app registers no service worker.
 *
 * These tests build the stack once (test/harness/stack.ts `buildStack`) and serve that build with
 * `vite preview` on a free port of their own, with a machine `offmac` paired to it for a diff.
 */

const OUT = path.join(REPO, "test-results/web-offline");

const BUILT = path.join(OUT, "build");

const SHOTS = path.join(REPO, "test-results/offline-shots");

const PHONE = { width: 420, height: 820 };

test.describe.configure({ mode: "serial" });

let stack: Stack;

let runner: Runner | undefined;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  buildStack(BUILT, path.join(OUT, "build.log"));
  stack = await startStack(path.join(OUT, "stack.log"), { built: BUILT });

  const offmac = machine("offmac", OUT);
  const paired = await offmac.pair(stack.url, await pairingCode(stack.url));

  if (paired.code !== 0) throw new Error(`offmac did not pair: ${paired.output}`);
  runner = offmac.launch(stack.url);
});

test.afterAll(async () => {
  await runner?.stop();
  await stack?.stop();
});

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });

const panel = (page: Page) => page.getByRole("complementary", { name: "Activity and settings" });

const chat = (page: Page) => page.getByRole("region", { name: "Chat" });

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Chats" });

/** What a page logs when a lazily loaded chunk can't be fetched, or React gives up on a render. */
const BROKEN = /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|error boundary|Minified React error/i;

/** Every error the page threw or logged, to check none came from a chunk it couldn't load. */
function errorsOf(page: Page): string[] {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  return errors;
}

/** The build's version and files, as its sw.js has them. */
const buildOf = (dir: string) => precacheList(path.join(dir, "client"));

/** Signed in, with the app open, connected, and its service worker in control (installed: the whole build cached). */
async function online(page: Page): Promise<void> {
  await page.context().addCookies([await accessCookie(stack.url)]);
  await page.goto(`${stack.url}/`);
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 60_000 }).toBe(true);
}

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/** Until the chat's view cache (src/view-cache.ts) holds `text`, so a cold start paints it. */
async function kept(page: Page, text: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ky:view-cache") ?? ""), { timeout: 20_000 }).toContain(text);
}

/** A fresh page with no network: a cold start of the installed app. */
async function coldOffline(context: BrowserContext, viewport?: { width: number; height: number }): Promise<{ page: Page; errors: string[] }> {
  await context.setOffline(true);
  const page = await context.newPage();

  if (viewport) await page.setViewportSize(viewport);
  const errors = errorsOf(page);
  await page.goto(`${stack.url}/`);

  return { page, errors };
}

const cacheNames = (page: Page) => page.evaluate(() => caches.keys());

const cached = (page: Page, name: string) =>
  page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname), name);

test("caches the whole build on install, the parts the page never loaded too", async ({ page }) => {
  const loaded: string[] = [];
  page.on("request", (request) => loaded.push(new URL(request.url()).pathname));
  await online(page);

  const build = buildOf(BUILT);
  expect(await cacheNames(page)).toEqual([`ky-${build.version}`]);
  expect((await cached(page, `ky-${build.version}`)).sort()).toEqual(["/", ...build.files].sort());

  // The lazily loaded parts (src/ui/Changes.tsx, Diagram.tsx and Markdown.tsx's import()s): cached, never loaded.
  for (const lazy of [/\/ChangesBody-/, /\/mermaid-/, /\/python-/]) {
    expect(build.files.some((file) => lazy.test(file))).toBe(true);
    expect(loaded.some((url) => lazy.test(url))).toBe(false);
  }

  expect(build.files).toEqual(expect.arrayContaining(["/manifest.webmanifest", "/icons/icon-192.png", "/favicon.svg"]));
});

test("starts cold with no network: the shell, the last chat from its cache, and a composer that takes a message", async ({ page, context }) => {
  await online(page);
  const id = crypto.randomUUID().slice(0, 8);
  await send(page, `lighthouse ${id}`);
  await expect(page.getByText(`echo: lighthouse ${id}`)).toBeVisible();
  await kept(page, `echo: lighthouse ${id}`);
  await page.close();

  const { page: cold, errors } = await coldOffline(context, PHONE);

  try {
    await expect(cold.getByText(`echo: lighthouse ${id}`)).toBeVisible();
    await expect(cold.getByRole("button", { name: /^ky: Connected/ })).toHaveCount(0);
    await expect(composer(cold)).toBeEnabled();
    await expect(composer(cold)).toHaveAttribute("placeholder", "Offline · sends on reconnect");
    await cold.screenshot({ path: path.join(SHOTS, "cold-offline-chat.png") });

    await send(cold, `written offline ${id}`);
    await expect(composer(cold)).toHaveValue("");
    await expect(cold.getByText(`written offline ${id}`, { exact: true })).toBeVisible();
    await cold.screenshot({ path: path.join(SHOTS, "cold-offline-sent.png") });
    expect(errors.filter((error) => BROKEN.test(error))).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});

test("opens every surface offline, the lazily loaded ones too, without a chunk error", async ({ page, context }) => {
  test.setTimeout(120_000);
  await online(page);
  const id = crypto.randomUUID().slice(0, 8);

  // What the cold start shows: a diagram, and a machine's changes, whose diff viewer the page hasn't loaded.
  // A side chat opened online, and one never opened on this device.
  await send(page, `tool chats ${JSON.stringify({ action: "create", title: `Seen ${id}`, message: `reply: seen side ${id}` })}`);
  const seen = sidebar(page).getByRole("button", { name: new RegExp(`^Seen ${id}`) });
  await expect(seen).toBeVisible();
  await send(page, `tool chats ${JSON.stringify({ action: "create", title: `Unseen ${id}`, message: `reply: unseen side ${id}` })}`);
  await expect(sidebar(page).getByRole("button", { name: new RegExp(`^Unseen ${id}`) })).toBeVisible();
  await seen.click();
  await expect(chat(page).getByText(`seen side ${id}`).first()).toBeVisible();
  await kept(page, `seen side ${id}`);
  await sidebar(page).getByRole("button", { name: "Main chat" }).click();
  await send(page, "machine@offmac [diff] change the code");
  await expect(page.getByRole("button", { name: /^Changes/ }).first()).toContainText("2 files", { timeout: 30_000 });
  await send(page, `reply: The plan ${id}:\n\n\`\`\`mermaid\nflowchart LR\n  Ask --> Draft --> Ship\n\`\`\``);
  await expect(chat(page).getByRole("img", { name: "Diagram" }).getByText("Draft")).toBeVisible();
  await kept(page, `The plan ${id}`);
  await page.close();

  const { page: cold, errors } = await coldOffline(context);

  const alive = async () => {
    await expect(sidebar(cold)).toBeVisible();
    expect(errors.filter((error) => BROKEN.test(error))).toEqual([]);
  };

  try {
    await expect(chat(cold).getByText(`The plan ${id}:`, { exact: true })).toBeVisible();
    await expect(chat(cold).getByRole("img", { name: "Diagram" }).getByText("Draft")).toBeVisible();

    // The diff viewer, from a chunk the page loads only now.
    const changes = cold.getByRole("button", { name: /^Changes/ }).first();
    await changes.click();
    await expect(cold.getByRole("button", { name: /a\.ts/ }).first()).toBeVisible();
    await alive();

    // A code fence written offline loads Shiki and its grammar now, from the cache.
    await send(cold, `\`\`\`python\nprint("offline ${id}")\n\`\`\``);
    await expect(cold.getByText(`offline ${id}`).last()).toBeVisible();
    await alive();

    await cold.keyboard.press("ControlOrMeta+k");
    const palette = cold.getByRole("dialog", { name: "Commands" });
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox", { name: "Search chats and commands" }).fill("sett");
    await palette.getByRole("option", { name: /Settings/ }).click();
    await expect(panel(cold).getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
    await alive();

    for (const row of ["Models", "Providers", "Tools", "Machines", "Subscriptions", "Proactivity", "Appearance", "Peers", "Mail", "Webhooks", "Self-edits"]) {
      const link = panel(cold).getByRole("button", { name: new RegExp(`^${row}`) }).first();
      const more = panel(cold).getByRole("button", { name: /^More/, expanded: false });

      if (!(await link.isVisible()) && (await more.isVisible())) await more.click();
      await link.click();
      await expect(panel(cold).getByRole("heading", { name: row, level: 3 }).first()).toBeVisible();
      await panel(cold).getByRole("button", { name: /^Settings$/ }).click();
      await alive();
    }

    await panel(cold).getByRole("tab", { name: "Activity" }).click();
    await alive();

    await sidebar(cold).getByRole("button", { name: "Skills" }).click();
    await expect(cold.getByRole("region", { name: "Skills" })).toBeVisible();
    await alive();
    await sidebar(cold).getByRole("button", { name: "Artifacts" }).click();
    await expect(cold.getByRole("region", { name: "Artifacts" })).toBeVisible();
    await alive();
    await sidebar(cold).getByRole("button", { name: "Routines" }).click();
    await expect(panel(cold).getByRole("region", { name: "Routines" }).or(cold.getByRole("region", { name: "Routines" }))).toBeVisible();
    await alive();

    // The side chat seen online paints from its cache. The other has messages only the server has: it says
    // so, rather than greeting an empty chat, and its composer still takes a message.
    await sidebar(cold).getByRole("button", { name: new RegExp(`^Seen ${id}`) }).click();
    await expect(chat(cold).getByText(`seen side ${id}`).first()).toBeVisible();
    await sidebar(cold).getByRole("button", { name: new RegExp(`^Unseen ${id}`) }).click();
    await expect(cold.getByRole("heading", { name: "Offline" })).toBeVisible();
    await expect(cold.getByRole("heading", { name: "A side chat" })).toHaveCount(0);
    await expect(composer(cold)).toBeEnabled();
    await cold.screenshot({ path: path.join(SHOTS, "cold-offline-unseen-chat.png") });
    await alive();

    // Back in the main chat, on a phone: the diagram and the changes, with no network.
    await sidebar(cold).getByRole("button", { name: "Main chat" }).click();
    await expect(chat(cold).getByRole("img", { name: "Diagram" }).getByText("Draft")).toBeVisible();
    await cold.setViewportSize(PHONE);
    await cold.keyboard.press("Escape");
    await expect(panel(cold)).toBeHidden();
    await cold.screenshot({ path: path.join(SHOTS, "cold-offline-surfaces.png"), animations: "disabled" });
  } finally {
    await context.setOffline(false);
  }
});

test("a diff viewer that can't load offline says so in its row, and the app stays up", async ({ page, context }) => {
  await online(page);
  await send(page, "machine@offmac [diff] change the code");
  await expect(page.getByRole("button", { name: /^Changes/ }).first()).toContainText("2 files", { timeout: 30_000 });
  await kept(page, "Shared the changes");
  // As if install had skipped the viewer's chunk, or a deploy had taken it away from an open page.
  const { version } = buildOf(BUILT);
  await page.evaluate(async (name) => {
    const cache = await caches.open(name);

    for (const request of await cache.keys()) {
      if (new URL(request.url).pathname.startsWith("/assets/ChangesBody-")) await cache.delete(request);
    }
  }, `ky-${version}`);
  await page.close();

  const { page: cold } = await coldOffline(context);

  try {
    await cold.getByRole("button", { name: /^Changes/ }).first().click();
    await expect(cold.getByText("The diff viewer couldn't load. Reload ky when it's online.")).toBeVisible();
    await expect(sidebar(cold)).toBeVisible();
    await expect(composer(cold)).toBeEnabled();
  } finally {
    await context.setOffline(false);
  }
});

test("never caches Access's sign-in redirect: offline, ky still starts from the app", async ({ page, context }) => {
  await online(page);
  const build = buildOf(BUILT);

  // Access's session ends: every request now goes to the team's login.
  await context.addCookies([{ name: "CF_Authorization", value: ENDED, url: stack.url }]);
  await context.route("https://ky-test.cloudflareaccess.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Sign in</title><h1>Sign in with Cloudflare Access</h1>" })
  );
  await page.goto(`${stack.url}/?ended=1`);
  await expect(page.getByRole("heading", { name: "Sign in with Cloudflare Access" })).toBeVisible();
  // An update check while signed out finds no new worker to install, and nothing changes.
  await page.goto(`${stack.url}/`);
  await expect(page.getByRole("heading", { name: "Sign in with Cloudflare Access" })).toBeVisible();

  const { page: cold, errors } = await coldOffline(context);

  try {
    await expect(sidebar(cold)).toBeVisible();
    await expect(composer(cold)).toBeEnabled();
    expect(await cacheNames(cold)).toEqual([`ky-${build.version}`]);

    const shell = await cold.evaluate(async (name) => {
      const response = await (await caches.open(name)).match("/");

      return { status: response?.status, redirected: response?.redirected, app: (await response?.text())?.includes('<div id="root">') };
    }, `ky-${build.version}`);

    expect(shell).toEqual({ status: 200, redirected: false, app: true });
    expect((await cached(cold, `ky-${build.version}`)).filter((url) => url.startsWith("/cdn-cgi/"))).toEqual([]);
    expect(errors.filter((error) => BROKEN.test(error))).toEqual([]);
  } finally {
    await context.setOffline(false);
    await context.unroute("https://ky-test.cloudflareaccess.com/**");
    await context.addCookies([await accessCookie(stack.url)]);
  }
});

// Last: it restarts the stack on the next build, with fresh state.
test("a new deploy's worker caches the new build and drops the old build's cache", async ({ page, context }) => {
  test.setTimeout(120_000);
  await online(page);
  const first = buildOf(BUILT);
  expect(await cacheNames(page)).toEqual([`ky-${first.version}`]);

  // The next deploy: this build with one file more, its sw.js filled in again as `vite build` fills it.
  const next = path.join(OUT, "next");
  cpSync(BUILT, next, { recursive: true });
  writeFileSync(path.join(next, "client/assets/deployed-next.js"), `export const deployed = "${crypto.randomUUID()}";\n`);
  const second = writePrecache(path.join(next, "client"));
  expect(second.version).not.toBe(first.version);

  const port = Number(new URL(stack.url).port);
  await stack.stop();
  stack = await startStack(path.join(OUT, "stack-next.log"), { built: next, port });

  // Opening ky checks for a new worker; it installs beside the old one, then takes over.
  await page.reload();
  await expect(page.getByRole("button", { name: /^ky: Connected/ })).toBeVisible();
  await expect.poll(() => cacheNames(page), { timeout: 60_000 }).toEqual([`ky-${second.version}`]);
  expect((await cached(page, `ky-${second.version}`)).sort()).toEqual(["/", ...second.files].sort());
  expect(second.files).toContain("/assets/deployed-next.js");
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe("activated");
  await page.close();

  // And the new build starts offline.
  const { page: cold, errors } = await coldOffline(context);

  try {
    await expect(sidebar(cold)).toBeVisible();
    await expect(composer(cold)).toBeEnabled();
    expect(errors.filter((error) => BROKEN.test(error))).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});
