import { describe, expect, it } from "vitest";
import type { PiOperationResult } from "agents/harness/pi";
import { inside, until } from "./drive";

/**
 * Only subagents browse; the main agent delegates it. So each test opens a
 * session set up with every extension, as a subagent's is, and browses there.
 */
function browser(name: string): Promise<string> {
  return inside(name, async (agent) => (await agent.harness.sessions.create()).id);
}

async function prompt(name: string, session: string, text: string): Promise<Omit<PiOperationResult, "messages">> {
  return inside(name, async (agent) => {
    const { messages: _messages, ...result } = await agent.harness.prompt(text, { session });

    return result;
  });
}

/** What the fake browser binding saw. */
function browserSaw(name: string): Promise<{ requested: number; launched: number; closes: number[] }> {
  return inside(name, ({ boundary: { browserFake } }) => ({
    requested: browserFake.requested,
    launched: browserFake.launched,
    closes: [...browserFake.closes]
  }));
}

/** Resolve once the one browser was closed, and stays closed once past the close grace period. */
async function closedOnce(name: string): Promise<void> {
  await until(async () => (await browserSaw(name)).closes[0] === 1, "the browser was closed", 15_000);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(await browserSaw(name)).toEqual({ requested: 1, launched: 1, closes: [1] });
}

describe("browse", () => {
  it("closes the browser once when the page cannot be opened", async () => {
    const name = crypto.randomUUID();
    const session = await browser(name);

    expect((await prompt(name, session, "browse https://example.com")).text).toMatch(
      /^tool failed: Could not browse https:\/\/example.com: .*the fake browser opens no pages/
    );
    await closedOnce(name);
  });

  it("closes a browser that finishes launching after the turn was stopped", async () => {
    const name = crypto.randomUUID();
    await inside(name, (agent) => {
      agent.boundary.browserFake.launchDelayMs = 7_000;
    });

    const session = await browser(name);
    const receipt = await inside(name, (agent) => agent.harness.submit("browse https://example.com", { session }));
    await until(async () => (await browserSaw(name)).requested === 1, "the launch started");

    await inside(name, (agent) => agent.harness.session(session).abort());
    await inside(name, (agent) => agent.harness.wait(receipt.operationId, { session }));
    // The stopped turn ended within the 5s close bound, long before the launch finishes.
    expect((await browserSaw(name)).launched).toBe(0);
    await closedOnce(name);
  });

  it("closes a browser that finishes launching after the launch timed out", { timeout: 50_000 }, async () => {
    const name = crypto.randomUUID();
    await inside(name, (agent) => {
      agent.boundary.browserFake.launchDelayMs = 27_000;
    });
    const session = await browser(name);

    expect((await prompt(name, session, "browse https://example.com")).text).toBe(
      "tool failed: Could not browse https://example.com: starting the browser took longer than 20s"
    );
    // The call gave up on the launch (20s) and on closing (5s); the browser is still on its way.
    expect((await browserSaw(name)).launched).toBe(0);
    await closedOnce(name);
  });

  // Slow on purpose: the cap is 90s, and only steps can run that long.
  it("ends a call whose page steps outlast the 90s cap, and closes the browser once", { timeout: 130_000 }, async () => {
    const name = crypto.randomUUID();
    await inside(name, (agent) => {
      agent.boundary.browserFake.opensPages = true;
    });

    const session = await browser(name);
    const started = Date.now();

    expect((await prompt(name, session, "browse-wait https://example.com 12")).text).toBe(
      "tool failed: Could not browse https://example.com: the whole browse call took longer than 90s"
    );
    // Twelve ten-second waits would take 120s; the cap ended the call near 90s.
    expect(Date.now() - started).toBeLessThan(110_000);
    await closedOnce(name);
  });
});
