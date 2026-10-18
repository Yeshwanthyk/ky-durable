import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { BrowserWorker, SessionlessBrowser as Browser } from "@cloudflare/playwright";
import { decodeOr } from "./core/decode";

/**
 * A cloud browser for pages a search API cannot read: ones that render with
 * JavaScript, need a click or a form, or are worth a screenshot. It runs on
 * Cloudflare Browser Rendering's Kitesurf browser, so it works while the
 * user's machines are offline. It has none of the user's logins; those go to
 * a machine.
 *
 * Each call opens a fresh page, runs the steps, reads the page and closes the
 * browser. Screenshots go over CDP, which Kitesurf pages support. Stopping the
 * turn, or the call's time cap, ends the call at once and closes the browser,
 * including one that only finishes launching later.
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

/** A larger PDF is refused, so one file cannot fill the Worker's memory. */
const MAX_PDF_BYTES = 15 * 1024 * 1024;

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
          "Open a URL in a cloud browser (no user logins) and read it: title, final URL, visible text and links, optionally a screenshot; " +
          "returns the page's main content; reads PDFs as text. " +
          "steps run in order after the page loads: click, fill, press or wait. " +
          "Use it when Exa web search cannot read a page: it needs JavaScript, a click or a form. Use a machine only when the page needs the user's logins.",
        parameters: Type.Object({
          url: Type.String(),
          steps: Type.Optional(Type.Array(Step, { maxItems: 20 })),
          screenshot: Type.Optional(Type.Boolean({ description: "Attach a PNG of the viewport." }))
        }),
        replay: "safe",
        execute: async (args, _api, context) => {
          // Running out of time is one more way the call is stopped.
          const timeUp = new AbortController();

          const timer = setTimeout(
            () => timeUp.abort(new Error(`the whole browse call took longer than ${CALL_TIMEOUT_MS / 1000}s`)),
            CALL_TIMEOUT_MS
          );

          const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeUp.signal]) : timeUp.signal;

          return browse(binding, args, signal)
            .catch((error: Error) => reply(`Could not browse ${args.url}: ${error.message}`, true))
            .finally(() => clearTimeout(timer));
        }
      })
    ]
  });
}

type Args = { url: string; steps?: Array<{ do: string; selector?: string; value?: string }>; screenshot?: boolean };

type Stopped = { readonly promise: Promise<never>; readonly dispose: () => void };

/** Rejects with the abort reason once `signal` aborts; `dispose` stops listening. */
function aborted(signal: AbortSignal): Stopped {
  let dispose = () => {};

  const promise = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error("the browse call was stopped"));

    if (signal.aborted) {
      fail();

      return;
    }

    signal.addEventListener("abort", fail, { once: true });
    dispose = () => signal.removeEventListener("abort", fail);
  });

  return { promise, dispose: () => dispose() };
}

async function browse(binding: BrowserWorker, args: Args, signal: AbortSignal) {
  signal.throwIfAborted();
  const { launch } = await import("@cloudflare/playwright");
  const launching = launch(binding, { browser: "kitesurf" });
  // A stop or the call timeout ends the call at once; the finally still closes the browser.
  const stopped = aborted(signal);
  stopped.promise.catch(() => undefined);

  try {
    const browser = await Promise.race([
      stopped.promise,
      within(OPERATION_TIMEOUT_MS, "starting the browser", launching)
    ]);

    return await Promise.race([stopped.promise, readPage(browser, args, signal)]);
  } finally {
    stopped.dispose();
    // Every path closes the browser exactly once, here, even one that launches after the call gave up.
    // Closing has hung before, and a launch can outlive the call; never let either hold the answer.
    const closing = launching.then(closeBrowser, () => undefined);
    await within(CLOSE_TIMEOUT_MS, "closing the browser", closing).catch(() => undefined);
  }
}

/** Open the page, run the steps and read it. */
async function readPage(browser: Browser, args: Args, signal: AbortSignal) {
  const page = await within(
    OPERATION_TIMEOUT_MS,
    "opening a page",
    browser.newPage({ viewport: { width: 1280, height: 900 } })
  );

  // Headless Chromium downloads a PDF it won't show, and the navigation fails; any other failure is the answer.
  const { response, downloaded } = await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }).then(
    (response) => ({ response, downloaded: false }),
    (error: Error) => {
      if (!/Download is starting|net::ERR_ABORTED/.test(error.message)) throw error;

      return { response: null, downloaded: true };
    }
  );

  await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);

  if (downloaded || reached(false, response?.headers()["content-type"]) === "pdf") {
    return pdfReply(response?.url() ?? args.url, response, args, signal);
  }

  for (const [index, step] of (args.steps ?? []).entries()) {
    const failed = await runStep(page, step).then(
      () => undefined,
      (error: Error) => error.message
    );

    if (failed) return reply(`Step ${index + 1} (${step.do} ${step.selector ?? ""}) failed: ${failed}`, true);
  }

  const read = await within(OPERATION_TIMEOUT_MS, "reading the page", page.evaluate(readDocument, MAX_LINKS));
  const text = cut(read.text);

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
}

/**
 * What a navigation reached: a PDF when its content type or its first bytes say so; otherwise the page
 * it showed, or, when it `downloaded` a file instead, a file browse cannot read.
 */
export function reached(downloaded: boolean, contentType: string | undefined, head?: Uint8Array): "pdf" | "page" | "file" {
  const magic = head !== undefined && new TextDecoder().decode(head.subarray(0, 5)) === "%PDF-";

  if (magic || contentType?.toLowerCase().startsWith("application/pdf") === true) return "pdf";

  return downloaded ? "file" : "page";
}

/** The reply for the PDF at `url`; `response` is the browser's when it showed the PDF, null when it downloaded it. */
export async function pdfReply(url: string, response: BrowserResponse | null, args: Args, signal: AbortSignal) {
  const file = await within(OPERATION_TIMEOUT_MS, "downloading the PDF", pdfFile(url, response, signal));

  if (!file) return reply(`${url} is a PDF over ${MAX_PDF_BYTES / 1024 / 1024} MB, too large to read.`, true);

  if (response === null && reached(true, file.contentType, file.bytes) !== "pdf") {
    return reply(`${url} downloads a file that is neither a page nor a PDF, so browse can't read it.`, true);
  }

  const ignored = Boolean(args.steps?.length) || args.screenshot === true;

  return within(OPERATION_TIMEOUT_MS, "reading the PDF", readPdf(url, file.bytes, ignored, signal));
}

/** What pdfFile needs of the browser's response. */
type BrowserResponse = { headers(): Record<string, string>; body(): Promise<Uint8Array> };

type PdfFile = { bytes: Uint8Array; contentType: string | undefined };

/**
 * The file at `url`: the browser's copy when it says it is within MAX_PDF_BYTES, else downloaded here, so
 * an unknown or larger size never sits whole in memory. Undefined when it is over MAX_PDF_BYTES.
 */
async function pdfFile(url: string, response: BrowserResponse | null, signal: AbortSignal): Promise<PdfFile | undefined> {
  const headers = response?.headers();

  if (response && Number(headers?.["content-length"] ?? Number.NaN) <= MAX_PDF_BYTES) {
    const bytes = await response.body().catch(() => undefined);

    if (bytes?.length && bytes.length <= MAX_PDF_BYTES) return { bytes, contentType: headers?.["content-type"] };
  }

  return fetchPdf(url, signal);
}

/**
 * The page's title, main content and first links, written to run in the page. The content is the visible
 * `main`, `article` or `[role=main]` with the most text, when it holds a good share of the page, else the
 * body, without navigation, headers, footers, sidebars or cookie banners; a page that is all of those
 * reads as its whole body.
 */
export function readDocument(maxLinks: number): PageRead {
  const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .flatMap((a) => {
      const text = (a.textContent ?? "").trim().replace(/\s+/g, " ");

      return text && a.href.startsWith("http") ? [{ text, href: a.href }] : [];
    })
    .slice(0, maxLinks);

  const body = document.body;

  if (!body) return { title: document.title, text: "", links };
  const all = body.innerText;

  // A hidden element's innerText is all its text, so only one on the screen counts.
  const largest = [...document.querySelectorAll<HTMLElement>("main, article, [role=main]")]
    .flatMap((element) =>
      element.checkVisibility({ visibilityProperty: true }) || getComputedStyle(element).display === "contents"
        ? [{ element, length: element.innerText.length }]
        : []
    )
    .sort((a, b) => b.length - a.length)[0];

  const root = largest && largest.length >= all.length * 0.4 ? largest.element : body;

  // A copy without the chrome, so the screenshot still sees the page as it was. innerText follows the
  // layout only for a rendered element, so the copy sits off screen while it is read. Media would load again.
  const copy = root.cloneNode(true);

  if (!(copy instanceof HTMLElement)) return { title: document.title, text: all, links };

  copy
    .querySelectorAll(
      "nav, header:not(article header), footer, aside, iframe, video, audio, [role=navigation], [role=banner], " +
        "[role=contentinfo], [aria-hidden=true], [id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i]"
    )
    .forEach((element) => element.remove());

  copy.style.cssText = `position: fixed; top: 0; left: -100000px; width: ${root.clientWidth || document.documentElement.clientWidth}px`;
  body.appendChild(copy);
  let text = "";

  try {
    text = copy.innerText.replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    copy.remove();
  }

  return { title: document.title, text: text.length < 200 ? all : text, links };
}

/**
 * The reply for the PDF at `url`: its title, page count and text, read page by page until MAX_TEXT.
 * `ignored` says steps or a screenshot were asked for, which a PDF has no use for.
 */
async function readPdf(url: string, bytes: Uint8Array, ignored: boolean, signal: AbortSignal) {
  const { getDocumentProxy, getMeta } = await import("unpdf");
  // A copy: pdf.js takes over the buffer it is given, and refuses Playwright's Buffer.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));

  try {
    const { info } = await getMeta(pdf);
    const title = decodeOr(Type.Object({ Title: Type.String({ minLength: 1 }) }), info, undefined)?.Title;
    const pages: string[] = [];

    for (let number = 1, length = 0; number <= pdf.numPages && length <= MAX_TEXT; number++) {
      signal.throwIfAborted();
      const { items } = await (await pdf.getPage(number)).getTextContent();
      const text = items.map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : "")).join("").trim();
      pages.push(text);
      length += text.length + 1;
    }

    const count = `${pdf.numPages} ${pdf.numPages === 1 ? "page" : "pages"}`;

    const summary = [
      `${title ?? (new URL(url).pathname.split("/").pop() || url)}\n${url} (PDF, ${count})`,
      ignored ? "Steps and screenshot don't apply to a PDF, so they were skipped." : "",
      cut(pages.join("\n").trim())
    ]
      .filter(Boolean)
      .join("\n\n");

    return reply(summary);
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** The file at `url`, or undefined when it is over MAX_PDF_BYTES. */
async function fetchPdf(url: string, signal: AbortSignal): Promise<PdfFile | undefined> {
  const response = await fetch(url, { signal, headers: { Accept: "application/pdf, */*", "User-Agent": "Mozilla/5.0 (compatible; ky)" } });

  if (!response.ok || !response.body) throw new Error(`fetching the PDF answered HTTP ${response.status}`);

  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of response.body) {
    if (!(chunk instanceof Uint8Array)) throw new Error("the PDF's download isn't bytes");
    size += chunk.length;

    // Leaving the loop cancels the download.
    if (size > MAX_PDF_BYTES) return undefined;
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { bytes, contentType: response.headers.get("content-type") ?? undefined };
}

function cut(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut at ${MAX_TEXT} characters]` : text;
}

function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms);
  });

  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

type Page = Awaited<ReturnType<Browser["newPage"]>>;

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
