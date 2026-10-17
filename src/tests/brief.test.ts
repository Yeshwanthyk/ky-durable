import { describe, expect, it } from "vitest";
import { browser, dreamTonight, inside, type Tab } from "./drive";

/**
 * The morning brief (src/dreaming/brief.ts) and what ky surfaced (src/dreaming/surfaced.ts), driven from the
 * browser: the night's dream writes the lines, the card's taps become outcomes Settings › Proactivity counts, and
 * after two weeks in a row of little use the dream gets fewer lines.
 */

const DAY = 86_400_000;

/** `count` messages from the user, each asking the night's dream for a brief line citing it (src/tests/stack.ts). */
async function askForLines(page: Tab, count: number): Promise<void> {
  for (let n = 0; n < count; n++) {
    await page.say(`For the morning: dream> tool anticipate {"action":"brief","text":"Line ${n}","messages":[$ID],"chip":"Tell me about ${n}"}`);
  }
}

const lines = (page: Tab) => page.latest("brief")?.brief.lines ?? [];

describe("the brief", () => {
  it("takes the dream's lines, and counts the card's act, pin and dismiss in Settings › Proactivity", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);
    await askForLines(page, 3);
    await dreamTonight(name);
    await page.until(() => lines(page).length === 3);

    const keys = lines(page).map((line) => line.key);
    expect(await page.send({ type: "brief-seen", keys })).toMatchObject({ type: "result" });

    for (const [type, key] of [["brief-act", keys[0]], ["brief-pin", keys[1]], ["brief-dismiss", keys[2]]] as const) {
      expect(await page.send({ type, key: key! })).toMatchObject({ type: "result" });
    }

    expect(await page.send({ type: "proactivity" })).toMatchObject({ type: "result", result: { accepted: { count: 2, of: 3 }, dismissed: { count: 1, of: 3 } } });
    page.close();
  });

  it("gets two lines from the dream after two weeks in a row with fewer than a quarter of its lines used", async () => {
    const name = crypto.randomUUID();
    // Seed: four lines shown 3 days ago and four 10 days ago, none used: each expired an hour after it showed.
    await inside(name, (instance) => {
      const now = Date.now();

      for (const daysAgo of [3, 10]) {
        for (let n = 0; n < 4; n++) {
          const at = now - daysAgo * DAY + n;
          const item = `past-${daysAgo}#${n}`;
          instance.surfaced.shown({ kind: "brief", loop: "dream", ref: `test:${item}`, item, text: item, expiresAt: at + 3_600_000 }, at);
        }
      }
    });
    const page = await browser(name);
    await askForLines(page, 3);
    await dreamTonight(name);

    await page.until(() => lines(page).length === 2);
    expect(lines(page).map((line) => line.text)).toEqual(["Line 0", "Line 1"]);
    page.close();
  });
});
