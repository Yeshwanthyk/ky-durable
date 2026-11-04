/**
 * ky's web app, as the owner uses it, on the local stack built as production builds it (strobe.json: perf/build.ts
 * builds and seeds it, perf/serve.ts serves a fresh copy of the seeded state per block), signed in through the
 * stack's fake Access.
 *
 *   bunx strobe bench perf/web.bench.ts --head . --check            each case once
 *   bunx strobe bench perf/web.bench.ts --base <dir> --head .       did a change help
 */
import { bench, web } from "@hona/strobe";
import { answer, finished } from "./content.ts";
import { LONG_CHAT } from "./stack.ts";

const COMPOSER = 'textarea[aria-label="Message"]';

const THREAD = "main.thread";

/** The main chat's last post, the Inbox digest routine's (test/stack/seed.ts): the page is ready when the owner can read it. */
const READY_TEXT = "The rest are receipts and newsletters.";

const MAIN_CHAT_READY = { selector: THREAD, text: READY_TEXT };

/**
 * Opens the long chat from the sidebar and waits for a rendered answer. Only answers draw a table (the owner's
 * message shows its markdown raw), and the stream case keeps adding turns, so no fixed turn number stays on the page.
 */
async function openLongChat(page: Parameters<NonNullable<Parameters<typeof bench>[0]["setup"]>>[0]["page"]): Promise<void> {
  // A page's selectors are CSS, which can't pick the row by its title: click it from the page, untimed.
  await page.eval((title: string) => {
    const row = [...document.querySelectorAll<HTMLElement>('nav[aria-label="Chats"] button')].find((button) => button.textContent?.includes(title));

    if (!row) throw new Error(`no chat row titled ${title}`);
    row.click();
  }, LONG_CHAT);
  await page.waitFor(`${THREAD} table`, { text: "e2e" });
}

let streamed = 1000;

/** The next answer the stream case asks for, numbered so its last line is its own. */
const nextAnswer = () => `reply: ${answer(++streamed)}`;

type Page = Parameters<typeof openLongChat>[0];

/** Puts `text` in the composer as a paste does, untimed: what's measured is ky streaming the answer back. */
function fill(page: Page, text: string): Promise<void> {
  return page.eval(
    (selector: string, value: string) => {
      const box = document.querySelector<HTMLTextAreaElement>(selector);

      if (!box) throw new Error(`no composer at ${selector}`);
      // React tracks a textarea's value through the prototype's setter: setting it there is what a paste does.
      Reflect.set(HTMLTextAreaElement.prototype, "value", value, box);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.focus();
    },
    COMPOSER,
    text
  );
}

export default bench({
  targets: {
    web: web({
      viewport: { width: 1366, height: 860 },
      // The stack's fake Access signs the owner in and redirects to `/` (src/tests/stack.ts): one 302 on both variants.
      url: "/cdn-cgi/access/login"
    })
  },

  async setup({ page, case: name }) {
    await page.waitFor(THREAD, { text: READY_TEXT });

    if (name === "scroll" || name === "stream") await openLongChat(page);

    if (name === "stream") await fill(page, nextAnswer());
    // page.idle() fails in setup on strobe 0.5.0 ("a page's selector is a CSS string"): settle for a fixed second.
    await page.wait(1_000);
  },

  cases: {
    /** First visit: a fresh browser, no service worker or HTTP cache, until the main chat shows. */
    "load-cold": {
      primary: "launch.ready",
      metrics: ["cpu.work", "main.work", "net.bytes"],
      launch: { until: MAIN_CHAT_READY, profile: "fresh" }
    },

    /** Every later open: the service worker and cache from the discarded first launch are there. */
    "load-warm": {
      primary: "launch.ready",
      metrics: ["cpu.work", "main.work", "net.bytes"],
      launch: { until: MAIN_CHAT_READY, profile: "warm" }
    },

    /** Typing a message in the main chat at a brisk 80 ms a key. */
    type: {
      primary: "interaction.p95",
      metrics: ["main.work", "main.busy"],
      run: ({ page }) => page.type(COMPOSER, "Can you check the staging deploy again tonight and ping me?", { delay: 80 }),
      async reset({ page }) {
        await page.press("ControlOrMeta+a");
        await page.press("Backspace");
      }
    },

    /** Reading back through the long chat: up through earlier pages, then down to the newest. */
    scroll: {
      primary: "main.busy",
      metrics: ["main.work", "frames.dropped.pct"],
      async run(run) {
        await run.phase("up", () => run.page.scroll(THREAD, { by: -6000, speed: 3000 }));
        await run.phase("down", () => run.page.scroll(THREAD, { by: 6000, speed: 3000 }));
      }
    },

    /**
     * One long markdown answer streaming into the long chat (about 1.1k characters at the fake model's pace). Each
     * run adds a turn, so a block's later runs stream into a slightly longer chat (strobe says NotSteady); the
     * thread shows only its last turns, and base and head grow alike. Enter goes to the composer `fill` focused.
     */
    stream: {
      primary: "main.busy",
      metrics: ["main.work", "frames.dropped.pct", "phase.answer"],
      timeout: 60_000,
      async run(run) {
        const turn = streamed;

        await run.phase("answer", async () => {
          await run.page.press("Enter", { selector: COMPOSER });
          await run.page.waitFor(THREAD, { text: finished(turn), timeout: 45_000 });
        });
      },
      reset: ({ page }) => fill(page, nextAnswer())
    }
  }
});
