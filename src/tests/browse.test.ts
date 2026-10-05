import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** Resolve once `check` holds, polling the object. */
async function until(check: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Never happened: ${what}`);
}

const fresh = () => env.PI_HARNESS_TEST.getByName(crypto.randomUUID());

describe("browse", () => {
  const closedOnce = async (stub: ReturnType<typeof fresh>) => {
    await until(async () => (await stub.browserSaw()).closes[0] === 1, "the browser was closed", 15_000);
    // Past the close grace period: nothing closes it a second time.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await stub.browserSaw()).toEqual({ requested: 1, launched: 1, closes: [1] });
  };

  it("closes the browser once when the page cannot be opened", async () => {
    const stub = fresh();

    expect((await stub.prompt("browse https://example.com")).text).toMatch(
      /^tool failed: Could not browse https:\/\/example.com: .*the fake browser opens no pages/
    );
    await closedOnce(stub);
  });

  it("closes a browser that finishes launching after the turn was stopped", async () => {
    const stub = fresh();
    await stub.setLaunchDelay(7_000);
    const receipt = await stub.submit("browse https://example.com");
    await until(async () => (await stub.browserSaw()).requested === 1, "the launch started");

    await stub.abort();
    await stub.wait(receipt.operationId);
    // The stopped turn ended within the 5s close bound, long before the launch finishes.
    expect((await stub.browserSaw()).launched).toBe(0);
    await closedOnce(stub);
  });

  it("closes a browser that finishes launching after the launch timed out", { timeout: 50_000 }, async () => {
    const stub = fresh();
    await stub.setLaunchDelay(27_000);

    expect((await stub.prompt("browse https://example.com")).text).toBe(
      "tool failed: Could not browse https://example.com: starting the browser took longer than 20s"
    );
    // The call gave up on the launch (20s) and on closing (5s); the browser is still on its way.
    expect((await stub.browserSaw()).launched).toBe(0);
    await closedOnce(stub);
  });
});
