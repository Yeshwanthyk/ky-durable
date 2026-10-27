import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Browser, browseCall, type Launch, type BrowserPage, pdfReply } from "../../src/browse/wiring";
import type { Refusable } from "../../src/core/edge";
import { budget } from "../parity/kit";

fc.configureGlobal({ baseSize: "large" });

const URL = "https://example.com/story";

const SECOND = 1_000;

const MB = 1024 * 1024;

type Stall = "launch" | "newPage" | "goto" | "evaluate" | "screenshot" | "none";

const never = <A>() => new Promise<A>(() => undefined);

type Options = { gotoError?: string; failing?: string[]; text?: string; closeHangs?: boolean };

function world(stall: Stall, options: Options = {}) {
  const ran: string[] = [];
  const seen = { closes: 0, transports: 0, ran, launch: () => {} };
  let closed = () => {};

  const act = (selector: string) => async () => {
    seen.ran.push(selector);

    if (options.failing?.includes(selector)) throw new Error(`no ${selector}`);
  };

  const page: BrowserPage = {
    goto: () => {
      if (options.gotoError !== undefined) return Promise.reject(new Error(options.gotoError));

      return stall === "goto" ? never() : Promise.resolve(null);
    },
    waitForLoadState: async () => undefined,
    evaluate: () => (stall === "evaluate" ? never() : Promise.resolve({ title: "A page", text: options.text ?? "Words", links: [] })),
    url: () => URL,
    locator: (selector) => ({ first: () => ({ click: act(selector), fill: act(selector), press: act(selector) }) }),
    context: () => ({
      newCDPSession: () =>
        stall === "screenshot" ? never() : Promise.resolve({ send: async () => ({ data: btoa("png") }), detach: async () => undefined })
    })
  };

  const browser: Browser = {
    newPage: () => (stall === "newPage" ? never() : Promise.resolve(page)),
    close: () => {
      seen.closes++;

      return options.closeHangs === true ? new Promise<void>((resolve) => (closed = resolve)) : Promise.resolve();
    },
    _connection: {
      toImpl: () => ({
        _connection: {
          _transport: {
            close: () => {
              seen.transports++;
              closed();
            }
          }
        }
      })
    }
  };

  const launch: Launch = () =>
    stall === "launch" ? new Promise<Browser>((resolve) => (seen.launch = () => resolve(browser))) : Promise.resolve(browser);

  return { seen, launch };
}

const turn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const settle = Effect.gen(function* () {
  for (let index = 0; index < 8; index++) yield* turn;
});

const onTestClock = <A>(program: Effect.Effect<A>) => Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));

function answeredAt<A, E>(call: Effect.Effect<A, E>, advances: number[]) {
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(call);
    let at = 0;
    yield* settle;

    for (const ms of advances) {
      if (fiber.pollUnsafe() !== undefined) break;
      yield* TestClock.adjust(ms);
      at += ms;
      yield* settle;
    }

    const exit = fiber.pollUnsafe();

    return { at, exit };
  });
}

const refusalOf = <A>(exit: Exit.Exit<A, Refusable> | undefined) =>
  exit !== undefined && Exit.isFailure(exit) ? Option.toArray(Cause.findErrorOption(exit.cause)).map((error) => error.refusal) : [];

const save = async () => "0123456789abcdef0123456789abcdef";

const toward = (total: number) => fc.array(fc.integer({ min: 1, max: 7 * SECOND }), { minLength: 1, maxLength: 12 }).map((steps) => [...steps, total, 5 * SECOND]);

function crossing(advances: number[], limit: number): number {
  let sum = 0;

  for (const ms of advances) {
    sum += ms;

    if (sum >= limit) return sum;
  }

  return sum;
}

describe("browse answers in time", () => {
  it("I-B1: a stalled launch, page, read or screenshot answers at 20s with what stalled, 5s later for a launch it waits to close, and the browser closes once", async () => {
    const STAGES = { launch: "starting the browser", newPage: "opening a page", evaluate: "reading the page", screenshot: "the screenshot" } as const;

    await fc.assert(
      fc.asyncProperty(fc.constantFrom("launch", "newPage", "evaluate", "screenshot" as const), toward(20 * SECOND), async (stall, advances) => {
        const { seen, launch } = world(stall);

        const { at, exit } = await onTestClock(
          Effect.gen(function* () {
            const answer = yield* answeredAt(browseCall(launch, { url: URL, screenshot: true }, save), advances);
            seen.launch();
            yield* settle;

            return answer;
          })
        );

        expect(refusalOf(exit)).toEqual([`${STAGES[stall]} took longer than 20s`]);
        expect(at).toBe(crossing(advances, stall === "launch" ? 25 * SECOND : 20 * SECOND));
        expect(seen.closes).toBe(1);
      }),
      budget()
    );
  });

  it("I-B2: a navigation that never settles ends the call at 90s, and the browser closes once", async () => {
    await fc.assert(
      fc.asyncProperty(toward(90 * SECOND), async (advances) => {
        const { seen, launch } = world("goto");
        const { at, exit } = await onTestClock(answeredAt(browseCall(launch, { url: URL }, save), advances));

        expect(refusalOf(exit)).toEqual(["the whole browse call took longer than 90s"]);
        expect(at).toBe(crossing(advances, 90 * SECOND));
        expect(seen.closes).toBe(1);
      }),
      budget()
    );
  });

  it("I-B3: a stop answers at once with its reason, and the browser closes once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 60 * SECOND }), fc.option(fc.string({ minLength: 1 }), { nil: undefined }), async (wait, reason) => {
        const { seen, launch } = world("goto");
        const stop = new AbortController();

        const { exit } = await onTestClock(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(browseCall(launch, { url: URL }, save, stop.signal));
            yield* settle;
            yield* TestClock.adjust(wait);
            yield* settle;
            stop.abort(reason === undefined ? "gone" : new Error(reason));
            yield* settle;

            return { exit: fiber.pollUnsafe() };
          })
        );

        expect(refusalOf(exit)).toEqual([reason ?? "the browse call was stopped"]);
        expect(seen.closes).toBe(1);
      }),
      budget()
    );
  });

  it("I-B4: a wait step waits its milliseconds, 1s when it names none, and never past 10s", async () => {
    const values = fc.option(fc.oneof(fc.integer({ min: -5 * SECOND, max: 30 * SECOND }).map(String), fc.constantFrom("", "soon", "0", "1e4")), { nil: undefined });

    await fc.assert(
      fc.asyncProperty(values, async (value) => {
        const asked = Number(value ?? 1000);
        const due = Math.min(Number.isNaN(asked) || asked === 0 ? 1000 : asked, 10 * SECOND);
        const { launch } = world("none");

        const { early, done } = await onTestClock(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(browseCall(launch, { url: URL, steps: [{ do: "wait", value }] }, save));
            yield* settle;

            if (due > 0) {
              yield* TestClock.adjust(due - 1);
              yield* settle;
            }

            const early = fiber.pollUnsafe();
            yield* TestClock.adjust(1);
            yield* settle;

            return { early, done: fiber.pollUnsafe() };
          })
        );

        expect(due <= 0 || early === undefined).toBe(true);
        expect(done !== undefined && Exit.isSuccess(done)).toBe(true);
      }),
      budget()
    );
  });
});

describe("browse answers with what happened", () => {
  afterEach(() => vi.restoreAllMocks());

  it("I-B9: steps run in order until the first that fails, which answers with its number, action, selector and words", async () => {
    const SELECTORS = ["#a", "#b", "#c", "#d"];
    const step = fc.record({ do: fc.constantFrom("click", "fill", "press" as const), selector: fc.option(fc.constantFrom(...SELECTORS), { nil: undefined }) });

    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 6 }), fc.subarray(SELECTORS), async (steps, failing) => {
        const { seen, launch } = world("none", { failing });
        const result = await Effect.runPromise(browseCall(launch, { url: URL, steps }, save));
        const first = steps.findIndex((each) => each.selector === undefined || failing.includes(each.selector));
        const tried = first === -1 ? steps : steps.slice(0, first + 1);

        expect(seen.ran).toEqual(tried.flatMap((each) => (each.selector === undefined ? [] : [each.selector])));
        expect(seen.closes).toBe(1);

        if (first === -1) {
          expect(result.isError).toBe(false);

          return;
        }

        const failed = tried[first];
        const words = failed?.selector === undefined ? "needs a selector" : `no ${failed.selector}`;

        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(`Step ${first + 1} (${failed?.do} ${failed?.selector ?? ""}) failed: ${words}`);
      }),
      budget()
    );
  });

  it("I-B10: a navigation that fails answers with the browser's words, unless they say a download started", async () => {
    const words = fc
      .oneof(fc.constantFrom("net::ERR_NAME_NOT_RESOLVED at https://example.com/story", "Timeout 30000ms exceeded."), fc.string({ minLength: 1 }))
      .filter((said) => !said.includes("Download is starting") && !said.includes("net::ERR_ABORTED"));

    await fc.assert(
      fc.asyncProperty(words, async (said) => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
        const { seen, launch } = world("none", { gotoError: said });
        const exit = await Effect.runPromise(Effect.exit(browseCall(launch, { url: URL }, save)));

        expect(refusalOf(exit)).toEqual([said]);
        expect(seen.closes).toBe(1);
      }),
      budget()
    );
  });

  it("I-B11: text over 400,000 characters is cut there and says so, and text of 400,000 or fewer is whole", async () => {
    const CAP = 400_000;

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(1, CAP - 1, CAP, CAP + 1, CAP + 5_000), async (length) => {
        const text = "w".repeat(length);
        const { launch } = world("none", { text });
        const said = textOf(await Effect.runPromise(browseCall(launch, { url: URL }, save)));
        const kept = length > CAP ? `${text.slice(0, CAP)}\n[cut at 400000 characters]` : text;

        expect(said).toBe(`A page\n${URL}\n\n${kept}`);
      }),
      budget()
    );
  });

  it("I-B12: a browser that won't close has its connection closed after 1s, and the call answers then", async () => {
    await fc.assert(
      fc.asyncProperty(toward(SECOND), async (advances) => {
        const { seen, launch } = world("none", { closeHangs: true });
        const { at, exit } = await onTestClock(answeredAt(browseCall(launch, { url: URL }, save), advances));

        expect(exit !== undefined && Exit.isSuccess(exit)).toBe(true);
        expect(at).toBe(crossing(advances, SECOND));
        expect(seen.closes).toBe(1);
        expect(seen.transports).toBe(1);
      }),
      budget()
    );
  });
});

function pdfBytes(padding: number): Uint8Array<ArrayBuffer> {
  const stream = "BT /F1 8 Tf 36 756 Td (Words) Tj ET";

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let body = `%PDF-1.4\n%${" ".repeat(padding)}\n`;

  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;

    return offset;
  });

  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

const TINY = pdfBytes(0);

const sized = new Map<number, Uint8Array<ArrayBuffer>>();

function pdfOf(size: number): Uint8Array<ArrayBuffer> {
  const known = sized.get(size);

  if (known) return known;
  let padding = size - TINY.length;
  let bytes = pdfBytes(padding);

  while (bytes.length !== size) {
    padding += size - bytes.length;
    bytes = pdfBytes(padding);
  }

  sized.set(size, bytes);

  return bytes;
}

function streamed(chunks: Uint8Array[], contentType: string | undefined) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });

  return new Response(body, { headers: contentType === undefined ? {} : { "content-type": contentType } });
}

const cutAt = (bytes: Uint8Array, at: number[]) => {
  const points = [...new Set(at.map((point) => point % bytes.length))].filter((point) => point > 0).sort((a, b) => a - b);

  return [0, ...points].map((start, index) => bytes.subarray(start, points[index] ?? bytes.length));
};

const textOf = (result: { output?: Array<{ type: string; text?: string }> }) => (result.output ?? []).map((part) => part.text).join("\n");

describe("browse reads only a PDF it can hold", () => {
  afterEach(() => vi.restoreAllMocks());

  it("I-B5: a download over 15 MB is refused, and one of 15 MB or less is read", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(15 * MB - 1, 15 * MB, 15 * MB + 1, 4 * 1024), fc.array(fc.nat(), { maxLength: 4 }), async (size, at) => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(streamed(cutAt(pdfOf(size), at), "application/pdf"));
        const said = textOf(await Effect.runPromise(pdfReply(URL, null, { url: URL })));

        expect(said).toBe(size > 15 * MB ? `${URL} is a PDF over 15 MB, too large to read.` : `story\n${URL} (PDF, 1 page)\n\nWords`);
      }),
      budget()
    );
  });

  it("I-B6: a download is read only when its type or first bytes say PDF; otherwise it is refused, as a page when it is HTML", async () => {
    const FIRST = { pdf: TINY, zip: new TextEncoder().encode("PK\u0003\u0004 zip bytes"), html: new TextEncoder().encode("<html>hi</html>") } as const;
    const TYPES = ["application/pdf", "application/octet-stream", "text/html; charset=utf-8", undefined] as const;

    await fc.assert(
      fc.asyncProperty(fc.constantFrom("pdf", "zip", "html" as const), fc.constantFrom(...TYPES), async (first, contentType) => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(streamed([FIRST[first]], contentType));
        const result = await Effect.runPromise(Effect.exit(pdfReply(URL, null, { url: URL })));
        const said = Exit.isSuccess(result) ? textOf(result.value) : "failed";
        const pdf = first === "pdf" || contentType === "application/pdf";

        if (!pdf && contentType?.startsWith("text/html")) expect(said).toBe(`${URL} aborted its navigation in the browser, so browse can't read it.`);
        else if (!pdf) expect(said).toBe(`${URL} downloads a file that is neither a page nor a PDF, so browse can't read it.`);
        else expect(said).not.toMatch(/can't read it/);
      }),
      budget()
    );
  });

  it("I-B7: a PDF fetch that fails is refused with its HTTP status, and one with no body says there is nothing to read", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 200, max: 599 }), fc.boolean(), async (status, empty) => {
        const bodiless = empty || [204, 205, 304].includes(status);
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bodiless ? null : TINY, { status, headers: { "content-type": "application/pdf" } }));
        const exit = await Effect.runPromise(Effect.exit(pdfReply(URL, null, { url: URL })));
        const said = Exit.isSuccess(exit) ? textOf(exit.value) : refusalOf(exit).join();

        if (status < 200 || status > 299) expect(said).toBe(`fetching the PDF answered HTTP ${status}`);
        else if (bodiless) expect(said).toBe(`${URL} answered HTTP ${status} with nothing to read.`);
        else expect(said).toBe(`story\n${URL} (PDF, 1 page)\n\nWords`);
      }),
      budget()
    );
  });

  it("I-B8: a PDF still unread at 20s answers then that reading it took too long", async () => {
    await fc.assert(
      fc.asyncProperty(toward(20 * SECOND), async (advances) => {
        vi.spyOn(globalThis, "fetch").mockImplementation(() => never());
        const { at, exit } = await onTestClock(answeredAt(pdfReply(URL, null, { url: URL }), advances));

        expect(refusalOf(exit)).toEqual(["reading the PDF took longer than 20s"]);
        expect(at).toBe(crossing(advances, 20 * SECOND));
      }),
      budget()
    );
  });
});
