import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { BrowserWorker, SessionlessBrowser as Browser } from "@cloudflare/playwright";

/**
 * A cloud browser for pages a search API cannot read: ones that render with
 * JavaScript, need a click or a form, or are worth a screenshot. It runs on
 * Cloudflare Browser Rendering's Kitesurf browser, so it works while the
 * user's machines are offline. It has none of the user's logins; those go to
 * a machine.
 *
 * Each call opens a fresh page, runs the steps, reads the page and closes the
 * browser. Screenshots go over CDP, which Kitesurf pages support. Stopping the
 * turn closes the browser, which fails whatever step is running.
 */

const NAVIGATION_TIMEOUT_MS = 30_000;

const SETTLE_TIMEOUT_MS = 5_000;

const STEP_TIMEOUT_MS = 10_000;

/** Launching, opening a page, reading it or a screenshot: each gets this long. */
const OPERATION_TIMEOUT_MS = 20_000;

/** The whole call, so a stuck browser cannot hold the turn. */
const CALL_TIMEOUT_MS = 90_000;

const CLOSE_TIMEOUT_MS = 5_000;

const MAX_TEXT = 20_000;

const MAX_LINKS = 60;

const CLOSE_GRACE_MS = 1_000;

const reply = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  isError
});

const Step = Type.Object({
  do: Type.Union([Type.Literal("click"), Type.Literal("fill"), Type.Literal("press"), Type.Literal("wait")]),
  selector: Type.Optional(
    Type.String({ description: "A Playwright selector, e.g. `text=Reviews`, `#q`, `role=button[name=\"Search\"]`." })
  ),
  value: Type.Optional(Type.String({ description: "fill: the text. press: a key like Enter. wait: milliseconds." }))
});

type PageRead = { title: string; text: string; links: Array<{ text: string; href: string }> };

export function browseExtension(binding: BrowserWorker): Extension {
  return defineExtension({
    name: "browse",
    tools: [
      defineTool({
        name: "browse",
        description:
          "Open a URL in a cloud browser (no user logins) and read it: title, final URL, visible text and links, optionally a screenshot. " +
          "steps run in order after the page loads: click, fill, press or wait. " +
          "Use it when Exa web search cannot read a page: it needs JavaScript, a click or a form. Use a machine only when the page needs the user's logins.",
        parameters: Type.Object({
          url: Type.String(),
          steps: Type.Optional(Type.Array(Step, { maxItems: 20 })),
          screenshot: Type.Optional(Type.Boolean({ description: "Attach a PNG of the viewport." }))
        }),
        replay: "safe",
        execute: async (args, _api, context) =>
          within(CALL_TIMEOUT_MS, "the whole browse call", browse(binding, args, context.abortSignal)).catch((error: Error) =>
            reply(`Could not browse ${args.url}: ${error.message}`, true)
          )
      })
    ]
  });
}

type Args = { url: string; steps?: Array<{ do: string; selector?: string; value?: string }>; screenshot?: boolean };

async function browse(binding: BrowserWorker, args: Args, signal: AbortSignal | undefined) {
  const { launch } = await import("@cloudflare/playwright");
  const browser = await within(OPERATION_TIMEOUT_MS, "starting the browser", launch(binding, { browser: "kitesurf" }));
  const close = once(() => closeBrowser(browser));
  signal?.addEventListener("abort", close, { once: true });

  try {
    signal?.throwIfAborted();

    const page = await within(
      OPERATION_TIMEOUT_MS,
      "opening a page",
      browser.newPage({ viewport: { width: 1280, height: 900 } })
    );

    const response = await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);

    for (const [index, step] of (args.steps ?? []).entries()) {
      const failed = await runStep(page, step).then(
        () => undefined,
        (error: Error) => error.message
      );

      if (failed) return reply(`Step ${index + 1} (${step.do} ${step.selector ?? ""}) failed: ${failed}`, true);
    }

    const read: PageRead = await within(OPERATION_TIMEOUT_MS, "reading the page", page.evaluate((maxLinks) => {
      const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
        .flatMap((a) => {
          const text = (a.textContent ?? "").trim().replace(/\s+/g, " ");

          return text && a.href.startsWith("http") ? [{ text, href: a.href }] : [];
        })
        .slice(0, maxLinks);

      return { title: document.title, text: document.body?.innerText ?? "", links };
    }, MAX_LINKS));

    const text = read.text.length > MAX_TEXT ? `${read.text.slice(0, MAX_TEXT)}\n[cut at ${MAX_TEXT} characters]` : read.text;

    const summary = [
      `${read.title}\n${page.url()}${response && !response.ok() ? ` (HTTP ${response.status()})` : ""}`,
      text,
      read.links.length === 0 ? "" : `Links:\n${read.links.map((link) => `- ${link.text}: ${link.href}`).join("\n")}`
    ]
      .filter(Boolean)
      .join("\n\n");

    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text: summary }
    ];

    if (args.screenshot) {
      const shot = await within(OPERATION_TIMEOUT_MS, "the screenshot", (async () => {
        const session = await page.context().newCDPSession(page);
        const result = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        await session.detach();

        return result;
      })());

      content.push({ type: "image", data: shot.data, mimeType: "image/png" });
    }

    return { content, isError: false };
  } finally {
    signal?.removeEventListener("abort", close);
    // Closing has hung before; never let it hold the answer.
    await within(CLOSE_TIMEOUT_MS, "closing the browser", close()).catch(() => undefined);
  }
}

function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms);
  });

  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

type Page = Awaited<ReturnType<Browser["newPage"]>>;

const once = (run: () => Promise<void>) => {
  let ran: Promise<void> | undefined;

  return () => (ran ??= run());
};

/**
 * Kitesurf takes `Browser.close` but leaves the DevTools socket open, so
 * `browser.close()` waits forever for the disconnect. Close the socket after a
 * grace period; that disconnects the browser and settles `close()`.
 */
async function closeBrowser(browser: Browser): Promise<void> {
  const closing = browser.close().catch(() => undefined);

  const closed = await Promise.race([
    closing.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), CLOSE_GRACE_MS))
  ]);

  if (closed) return;

  browserSocket(browser)?.close();
  await closing;
}

/**
 * The DevTools socket, through the same internal hop launch() takes
 * (browser._connection.toImpl(browser)._connection._transport). Every step is
 * optional, so a changed shape yields nothing and the caller's timeout still
 * bounds the wait.
 */
function browserSocket(browser: Browser & {
  _connection?: { toImpl?(browser: Browser): { _connection?: { _transport?: { close(): void } } } };
}) {
  return browser._connection?.toImpl?.(browser)?._connection?._transport;
}

async function runStep(page: Page, step: { do: string; selector?: string; value?: string }): Promise<void> {
  if (step.do === "wait") {
    await page.waitForTimeout(Math.min(Number(step.value ?? 1000) || 1000, STEP_TIMEOUT_MS));

    return;
  }

  if (!step.selector) throw new Error("needs a selector");
  const target = page.locator(step.selector).first();

  if (step.do === "click") await target.click({ timeout: STEP_TIMEOUT_MS });
  else if (step.do === "fill") await target.fill(step.value ?? "", { timeout: STEP_TIMEOUT_MS });
  else await target.press(step.value ?? "Enter", { timeout: STEP_TIMEOUT_MS });

  await page.waitForLoadState("domcontentloaded", { timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
}
