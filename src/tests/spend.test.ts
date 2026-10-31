import { describe, expect, it } from "vitest";
import type { SpendView } from "../protocol";
import { capNotice } from "../spend/contract";
import { browser, inside, type Tab } from "./drive";

/**
 * Settings › Spend on ky's real Worker: every model answer pi gets lands in the ledger, the daily cap holds
 * unasked work once today reaches it, and the user's own chat keeps answering with one notice a day. How days
 * and months add up in a zone is proved in test/invariants/spend.test.ts.
 */

const spendOf = async (page: Tab): Promise<SpendView> => {
  const frame = await page.send({ type: "spend" });

  if (frame?.type !== "result") throw new Error(`spend: ${JSON.stringify(frame)}`);

  // SAFETY: the "spend" ask's answer is a SpendView (src/server-frames.ts).
  return frame.result as SpendView;
};

const kySaid = (page: Tab) =>
  page
    .view()
    .messages.filter((message) => message.role === "assistant")
    .map((message) => message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""));

describe("spend", () => {
  it("counts the chat's answers, and over the cap holds a look and tells the chat once while it keeps answering", async () => {
    const name = crypto.randomUUID();
    const page = await browser(name);

    expect(await spendOf(page)).toMatchObject({ capUsd: null, capped: false, held: [] });

    await page.say("hello");
    expect((await spendOf(page)).lines).toEqual([expect.objectContaining({ purpose: "main", source: "chat", calls: 1 })]);

    expect(await page.send({ type: "set-spend-cap", usd: 0 })).toMatchObject({ type: "result", result: { refused: "A daily cap is a number of dollars above 0." } });
    expect(await page.send({ type: "set-spend-cap", usd: 1 })).toMatchObject({ type: "result", result: { capUsd: 1, capped: false } });

    await inside(name, (instance) =>
      instance.spend.record({ purpose: "background", source: "look", provider: "p", model: "m", tokensIn: 0, tokensOut: 0, costUsd: 1.5 })
    );

    await inside(name, (instance) => instance.looks.run("08:00"));
    expect(await inside(name, (instance) => instance.feed.list().filter((task) => task.worker === "looks"))).toEqual([]);
    expect(await spendOf(page)).toMatchObject({ capped: true, held: [{ work: "look", why: "Today's spend $1.50 reached the $1.00 daily cap." }] });

    await page.say("still there?");
    await page.say("and now?");
    expect(kySaid(page).filter((text) => text === capNotice(1))).toHaveLength(1);
    expect(kySaid(page)).toContain("echo: and now?");

    expect(await page.send({ type: "set-spend-cap", usd: null })).toMatchObject({ type: "result", result: { capUsd: null, capped: false } });
    page.close();
  });
});
