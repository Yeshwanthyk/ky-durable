import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { BrowserWorker } from "@cloudflare/playwright";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { makeEdge } from "../core/edge";
import { isRefusal } from "../core/refusal";
import { toolReply as reply } from "../core/reply";
import {
  type Args,
  Failed,
  NotAPdf,
  NothingToRead,
  PageRead,
  type Part,
  PdfAnswered,
  PdfInfo,
  type Reply,
  type Step,
  Stopped,
  TookTooLong,
  TooLarge
} from "./contract";

const NAVIGATION_TIMEOUT_MS = 30_000;

const SETTLE_TIMEOUT_MS = 5_000;

const STEP_TIMEOUT_MS = 10_000;

const OPERATION_TIMEOUT_MS = 20_000;

const CALL_TIMEOUT_MS = 90_000;

const CLOSE_TIMEOUT_MS = 5_000;

const CLOSE_GRACE_MS = 1_000;

const MAX_TEXT = 400_000;

const MAX_LINKS = 60;

const MAX_PDF_BYTES = 15 * 1024 * 1024;

const DOWNLOADED = /Download is starting|net::ERR_ABORTED/;

const StepParameter = Type.Object({
  do: Type.Union([Type.Literal("click"), Type.Literal("fill"), Type.Literal("press"), Type.Literal("wait")]),
  selector: Type.Optional(
    Type.String({ description: "A Playwright selector, e.g. `text=Reviews`, `#q`, `role=button[name=\"Search\"]`." })
  ),
  value: Type.Optional(Type.String({ description: "fill: the text. press: a key like Enter. wait: milliseconds." }))
});

type Shown = { headers(): Record<string, string>; body(): Promise<Uint8Array> };

type Response = Shown & { ok(): boolean; status(): number; url(): string };

type Locator = {
  click(options: { timeout: number }): Promise<void>;
  fill(value: string, options: { timeout: number }): Promise<void>;
  press(key: string, options: { timeout: number }): Promise<void>;
};

type CdpSession = {
  send(method: "Page.captureScreenshot", params: { format: "png"; captureBeyondViewport: boolean }): Promise<{ data: string }>;
  detach(): Promise<void>;
};

export interface Page {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<Response | null>;
  waitForLoadState(state: "networkidle" | "domcontentloaded", options: { timeout: number }): Promise<void>;
  evaluate(read: (maxLinks: number) => PageRead, maxLinks: number): Promise<PageRead>;
  url(): string;
  locator(selector: string): { first(): Locator };
  context(): { newCDPSession(page: Pick<Page, "url">): Promise<CdpSession> };
}

export type Browser = {
  newPage(options: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
  _connection?: { toImpl?(browser: Browser): { _connection?: { _transport?: { close(): void } } } };
};

export type Launch = () => Promise<Browser>;

type Save = (png: Uint8Array) => Promise<string>;

const failed = (cause: unknown) => new Failed({ said: cause instanceof Error ? cause.message : String(cause) });

const tookTooLong = (ms: number, what: string) => () => Effect.fail(new TookTooLong({ what, ms }));

function within<A>(ms: number, what: string, work: () => Promise<A>) {
  return Effect.tryPromise({ try: work, catch: failed }).pipe(Effect.timeoutOrElse({ duration: ms, orElse: tookTooLong(ms, what) }));
}

export function browseExtension(binding: BrowserWorker, save: Save): Extension {
  const edge = makeEdge(Layer.empty);
  const launch: Launch = () => import("@cloudflare/playwright").then((playwright) => playwright.launch(binding, { browser: "kitesurf" }));

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
          steps: Type.Optional(Type.Array(StepParameter, { maxItems: 20 })),
          screenshot: Type.Optional(Type.Boolean({ description: "Attach a PNG of the viewport." }))
        }),
        replay: "safe",
        execute: async (args, _api, context) => {
          const result = await edge.runPromise(browseCall(launch, args, save, context.abortSignal));

          return isRefusal(result) ? reply(`Could not browse ${args.url}: ${result.refused}`, true) : result;
        }
      })
    ]
  });
}

export function browseCall(launch: Launch, args: Args, save: Save, signal?: AbortSignal) {
  return browse(launch, args).pipe(
    Effect.timeoutOrElse({ duration: CALL_TIMEOUT_MS, orElse: tookTooLong(CALL_TIMEOUT_MS, "the whole browse call") }),
    Effect.raceFirst(stoppedBy(signal)),
    Effect.flatMap((result) => keepShots(result, save))
  );
}

function stoppedBy(signal: AbortSignal | undefined): Effect.Effect<never, Stopped> {
  if (signal === undefined) return Effect.never;

  return Effect.callback<never, Stopped>((resume) => {
    const stop = () => resume(Effect.fail(new Stopped({ reason: signal.reason instanceof Error ? signal.reason.message : "the browse call was stopped" })));

    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });

    return Effect.sync(() => signal.removeEventListener("abort", stop));
  });
}

export function keepShots(result: Reply, save: Save) {
  return Effect.forEach(result.output ?? [], (part): Effect.Effect<Part[]> => {
    if (part.type !== "image") return Effect.succeed([part]);

    return Effect.tryPromise(() => save(Uint8Array.from(atob(part.data), (char) => char.charCodeAt(0)))).pipe(
      Effect.match({
        onFailure: () => [part],
        onSuccess: (id) => [
          part,
          { type: "text", text: `Screenshot saved as file ${id}. To show it to the user, pass this id on; the ui tool's image block shows it.` }
        ]
      })
    );
  }).pipe(Effect.map((parts) => ({ ...result, output: parts.flat() })));
}

function browse(launch: Launch, args: Args) {
  return Effect.acquireUseRelease(
    Effect.try({ try: launch, catch: failed }),
    (launching) => within(OPERATION_TIMEOUT_MS, "starting the browser", () => launching).pipe(Effect.flatMap((browser) => readPage(browser, args))),
    (launching) =>
      Effect.forkDetach(Effect.tryPromise(() => launching).pipe(Effect.flatMap(closeBrowser), Effect.ignore)).pipe(
        Effect.flatMap((closing) => Fiber.join(closing).pipe(Effect.interruptible, Effect.timeoutOption(CLOSE_TIMEOUT_MS))),
        Effect.asVoid
      )
  );
}

function readPage(browser: Browser, args: Args) {
  return Effect.gen(function* () {
    const page = yield* within(OPERATION_TIMEOUT_MS, "opening a page", () => browser.newPage({ viewport: { width: 1280, height: 900 } }));

    const { response, downloaded } = yield* Effect.tryPromise({
      try: () => page.goto(args.url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
      catch: failed
    }).pipe(
      Effect.map((response) => ({ response, downloaded: false })),
      Effect.catchTag("Failed", (error) => (DOWNLOADED.test(error.said) ? Effect.succeed({ response: null, downloaded: true }) : Effect.fail(error)))
    );

    yield* Effect.tryPromise(() => page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS })).pipe(Effect.ignore);

    if (downloaded || reached(false, response?.headers()["content-type"]) === "pdf") return yield* pdfReply(response?.url() ?? args.url, response, args);

    for (const [index, step] of (args.steps ?? []).entries()) {
      const stepFailed = yield* runStep(page, step).pipe(Effect.match({ onFailure: (error) => error.said, onSuccess: () => undefined }));

      if (stepFailed !== undefined) return reply(`Step ${index + 1} (${step.do} ${step.selector ?? ""}) failed: ${stepFailed}`, true);
    }

    const read = yield* within(OPERATION_TIMEOUT_MS, "reading the page", () => page.evaluate(readDocument, MAX_LINKS)).pipe(
      Effect.flatMap((raw) => Schema.decodeUnknownEffect(PageRead)(raw).pipe(Effect.mapError((error) => new Failed({ said: error.message }))))
    );

    const summary = [
      `${read.title}\n${page.url()}${response && !response.ok() ? ` (HTTP ${response.status()})` : ""}`,
      cut(read.text),
      read.links.length === 0 ? "" : `Links:\n${read.links.map((link) => `- ${link.text}: ${link.href}`).join("\n")}`
    ]
      .filter(Boolean)
      .join("\n\n");

    const output: Part[] = [{ type: "text", text: summary }];

    if (args.screenshot) {
      const shot = yield* within(OPERATION_TIMEOUT_MS, "the screenshot", async () => {
        const session = await page.context().newCDPSession(page);
        const result = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        await session.detach();

        return result;
      });

      output.push({ type: "image", data: shot.data, mimeType: "image/png" });
    }

    return { output, isError: false };
  });
}

function runStep(page: Page, step: Step): Effect.Effect<void, Failed> {
  if (step.do === "wait") return Effect.sleep(Math.min(Number(step.value ?? 1000) || 1000, STEP_TIMEOUT_MS));

  const selector = step.selector;

  if (!selector) return Effect.fail(new Failed({ said: "needs a selector" }));

  return Effect.tryPromise({
    try: () => {
      const target = page.locator(selector).first();

      if (step.do === "click") return target.click({ timeout: STEP_TIMEOUT_MS });

      if (step.do === "fill") return target.fill(step.value ?? "", { timeout: STEP_TIMEOUT_MS });

      return target.press(step.value ?? "Enter", { timeout: STEP_TIMEOUT_MS });
    },
    catch: failed
  }).pipe(Effect.andThen(Effect.tryPromise(() => page.waitForLoadState("domcontentloaded", { timeout: STEP_TIMEOUT_MS })).pipe(Effect.ignore)));
}

function reached(downloaded: boolean, contentType: string | undefined, head?: Uint8Array): "pdf" | "page" | "file" {
  const magic = head !== undefined && new TextDecoder().decode(head.subarray(0, 5)) === "%PDF-";

  if (magic || contentType?.toLowerCase().startsWith("application/pdf") === true) return "pdf";

  return downloaded ? "file" : "page";
}

export function pdfReply(url: string, response: Shown | null, args: Args) {
  const ignored = Boolean(args.steps?.length) || args.screenshot === true;

  return pdfFile(url, response).pipe(
    Effect.flatMap((bytes) => readPdf(url, bytes, ignored)),
    Effect.timeoutOrElse({ duration: OPERATION_TIMEOUT_MS, orElse: tookTooLong(OPERATION_TIMEOUT_MS, "reading the PDF") }),
    Effect.catchTags({
      NothingToRead: (error) => Effect.succeed(reply(error.refusal, true)),
      NotAPdf: (error) => Effect.succeed(reply(error.refusal, true)),
      TooLarge: (error) => Effect.succeed(reply(error.refusal, true))
    })
  );
}

function pdfFile(url: string, response: Shown | null) {
  return Effect.gen(function* () {
    const headers = response?.headers();
    const encoding = headers?.["content-encoding"] ?? "identity";

    if (response && encoding === "identity" && Number(headers?.["content-length"] ?? Number.NaN) <= MAX_PDF_BYTES) {
      const bytes = yield* within(OPERATION_TIMEOUT_MS, "the browser's copy", () => response.body()).pipe(Effect.option);

      if (Option.isSome(bytes) && bytes.value.length > 0 && bytes.value.length <= MAX_PDF_BYTES) return bytes.value;
    }

    return yield* fetchPdf(url, response === null);
  });
}

function fetchPdf(url: string, downloaded: boolean) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(url, { signal, headers: { Accept: "application/pdf, */*", "User-Agent": "Mozilla/5.0 (compatible; ky)" } }),
      catch: failed
    });

    if (!response.ok) return yield* new PdfAnswered({ status: response.status });
    const body: ReadableStream<Uint8Array> | null = response.body;

    if (!body || response.status === 204 || response.status === 205) return yield* new NothingToRead({ url, status: response.status });
    const contentType = response.headers.get("content-type") ?? undefined;

    return yield* Effect.acquireUseRelease(
      Effect.try({ try: () => body.getReader(), catch: failed }),
      (reader) => download(reader, url, downloaded, contentType),
      (reader) => Effect.tryPromise(() => reader.cancel()).pipe(Effect.ignore)
    );
  });
}

function download(reader: ReadableStreamDefaultReader<Uint8Array>, url: string, downloaded: boolean, contentType: string | undefined) {
  return Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let size = 0;

    for (;;) {
      const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: failed });

      if (chunk.done) break;

      if (size === 0 && reached(downloaded, contentType, chunk.value) === "file") {
        return yield* new NotAPdf({ url, aborted: contentType?.startsWith("text/html") === true });
      }

      size += chunk.value.length;

      if (size > MAX_PDF_BYTES) return yield* new TooLarge({ url, mb: MAX_PDF_BYTES / 1024 / 1024 });
      chunks.push(chunk.value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return bytes;
  });
}

function readPdf(url: string, bytes: Uint8Array, ignored: boolean) {
  return Effect.gen(function* () {
    const { getDocumentProxy, getMeta } = yield* Effect.promise(() => import("unpdf"));

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({ try: () => getDocumentProxy(new Uint8Array(bytes)), catch: failed }),
      (pdf) =>
        Effect.gen(function* () {
          const { info } = yield* Effect.tryPromise({ try: () => getMeta(pdf), catch: failed });
          const title = Option.getOrUndefined(Schema.decodeUnknownOption(PdfInfo)(info))?.Title;
          const pages: string[] = [];

          for (let number = 1, length = 0; number <= pdf.numPages && length <= MAX_TEXT; number++) {
            const { items } = yield* Effect.tryPromise({ try: async () => (await pdf.getPage(number)).getTextContent(), catch: failed });
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
        }),
      (pdf) => Effect.tryPromise(() => pdf.loadingTask.destroy()).pipe(Effect.ignore)
    );
  });
}

function cut(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut at ${MAX_TEXT} characters]` : text;
}

function closeBrowser(browser: Browser) {
  return Effect.gen(function* () {
    const closing = browser.close().catch(() => undefined);
    const closed = yield* Effect.promise(() => closing).pipe(Effect.timeoutOption(CLOSE_GRACE_MS));

    if (Option.isSome(closed)) return;
    browser._connection?.toImpl?.(browser)?._connection?._transport?.close();
    yield* Effect.promise(() => closing);
  });
}

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

  const largest = [...document.querySelectorAll<HTMLElement>("main, article, [role=main]")]
    .flatMap((element) =>
      element.checkVisibility({ visibilityProperty: true }) ||
      (getComputedStyle(element).display === "contents" && element.parentElement?.checkVisibility({ visibilityProperty: true }) === true)
        ? [{ element, length: element.innerText.length }]
        : []
    )
    .sort((a, b) => b.length - a.length)[0];

  const root = largest && largest.length >= all.length * 0.4 ? largest.element : body;
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
