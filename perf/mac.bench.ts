/**
 * ky's Mac app (apps/mac) as the owner uses it, on the seeded perf stack (perf/build.ts: a week of use and a 60-turn
 * long chat) that perf/mac/bench.sh serves and signs it in to. Selectors are the app's element keys, which Rune
 * gives the accessibility tree as identifiers; the seeded state is copied fresh per block, so its ids hold.
 *
 *   perf/mac/stage.sh head
 *   perf/mac/bench.sh --head exe:perf/.out/mac/head/ky-mac --check                                   each case once
 *   perf/mac/bench.sh --base exe:perf/.out/mac/base/ky-mac --head exe:perf/.out/mac/head/ky-mac      did a change help
 */
import { bench, native } from "@hona/strobe";
import { answer } from "./content.ts";

/** The main chat's last answer (test/stack/seed.ts's Inbox digest): the app has drawn the chat it opens on. */
const MAIN_READY = "copy:1:e285";

/** The long chat's sidebar row, tab and transcript. */
const LONG_ROW = "row:286";

const LONG = "transcript:286";

type Page = Parameters<NonNullable<Parameters<typeof bench>[0]["setup"]>>[0]["page"];

async function openLong(page: Page): Promise<void> {
  await page.click(LONG_ROW, { until: LONG });
  await page.idle();
}

let streamed = 2000;

export default bench({
  targets: { mac: native("ky-mac", { output: true, viewport: { width: 1280, height: 860 } }) },
  async setup({ page }) {
    await page.waitFor(MAIN_READY);
    await page.idle();
  },
  cases: {
    /** Speed: from spawn to the main chat's history drawn (the app says so on stdout under strobe). */
    launch: {
      primary: "launch.ready",
      launch: { until: { milestone: "chat" }, milestones: { chat: { match: '"name":"ready"', in: "output" } } },
    },
    /** Usage: the long chat open and nothing happening. */
    idle: {
      primary: "ui.cpu",
      run: async (run) => {
        const { page } = run;

        await run.untimed(() => openLong(page));
        await page.wait(5000);
      },
      reset: async ({ page }) => {
        await page.click("row:1", { until: MAIN_READY });
        await page.idle();
      },
    },
    /** Speed: switching between the main chat and the long chat, ten times each way (a p95 needs 20 inputs). */
    open: {
      primary: "interaction.p95",
      run: async ({ page }) => {
        for (let i = 0; i < 10; i++) {
          await page.click(LONG_ROW, { until: LONG });
          await page.idle();
          await page.click("row:1", { until: MAIN_READY });
          await page.idle();
        }
      },
      reset: async ({ page }) => {
        await page.click("row:1", { until: MAIN_READY });
        await page.idle();
      },
    },
    /** Movement: scrolling up through the long chat's turns, then back down. */
    scroll: {
      primary: "ui.cpu",
      run: async (run) => {
        const { page } = run;

        await run.untimed(() => openLong(page));
        await run.phase("up", () => page.scroll(LONG, { by: -9000, speed: 3000 }));
        await run.phase("down", () => page.scroll(LONG, { by: 9000, speed: 3000 }));
      },
      reset: async ({ page }) => {
        await page.click("row:1", { until: MAIN_READY });
        await page.idle();
      },
    },
    /** Movement: the window dragged narrower and wider over the long chat. */
    resize: {
      primary: "ui.cpu",
      run: async (run) => {
        const { page } = run;

        await run.untimed(() => openLong(page));

        for (const width of [1220, 1160, 1100, 1040, 980, 920, 860, 920, 980, 1040, 1100, 1160, 1220, 1280]) {
          await page.window({ resize: { width, height: 860 } });
        }
      },
      reset: async ({ page }) => {
        await page.window("restore");
        await page.click("row:1", { until: MAIN_READY });
        await page.idle();
      },
    },
    /** Speed: typing into the composer. */
    type: {
      primary: "interaction.p95",
      run: ({ page }) => page.type("composer", "what changed in the build today", { delay: 60 }),
      reset: async ({ page }) => {
        await page.press("ControlOrMeta+a");
        await page.press("Backspace");
      },
    },
    /** Perf: a long markdown answer streaming into the long chat. */
    stream: {
      primary: "ui.cpu",
      run: async (run) => {
        const { page } = run;

        const turn = ++streamed;
        await run.untimed(async () => {
          await openLong(page);
          await page.act("composer", "setValue", { value: `reply: ${answer(turn)}` });
        });
        await page.press("Enter");
        await page.waitFor({ text: `turn ${turn} done` });
        await page.idle();
      },
      // Each run adds a turn to the long chat: the next streams below it.
      resetCheck: false,
    },
  },
});
