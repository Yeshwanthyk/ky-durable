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

describe("executor tools over MCP", () => {
  it("runs a program once and answers with its result", async () => {
    const stub = fresh();

    expect((await stub.prompt("executor hello")).text).toBe("tool said: ran 1");
    expect(await stub.executorSaw("hello")).toEqual({ runs: 1, cancelled: 0, sessions: 1 });
  });

  it("never runs a program again when its response is lost after it ran", async () => {
    const stub = fresh();

    const { text } = await stub.prompt("executor lose-response");
    expect(text).toMatch(/^tool failed: Executor call failed: .*Network connection lost/);
    expect((await stub.executorSaw("lose-response")).runs).toBe(1);
  });

  it("retries once on a fresh session when Executor expired the old one", async () => {
    const stub = fresh();
    await stub.prompt("executor first");
    await stub.expireExecutorSessions();

    expect((await stub.prompt("executor second")).text).toBe("tool said: ran 1");
    expect(await stub.executorSaw("second")).toEqual({ runs: 1, cancelled: 0, sessions: 2 });
  });

  it("retries once when the connection cannot be made, and reports a second failure", async () => {
    const stub = fresh();
    await stub.refuseExecutorConnects(1);
    expect((await stub.prompt("executor once")).text).toBe("tool said: ran 1");

    const other = fresh();
    await other.refuseExecutorConnects(2);
    expect((await other.prompt("executor never")).text).toMatch(/^tool failed: Executor call failed:/);
    expect((await other.executorSaw("never")).runs).toBe(0);
  });

  it("cancels the call at Executor when the turn is stopped", async () => {
    const stub = fresh();
    await stub.submit("executor hang");
    await until(async () => (await stub.executorSaw("hang")).runs === 1, "the program started");

    await stub.abort();
    await until(async () => (await stub.executorSaw("hang")).cancelled === 1, "Executor saw the cancel");
    expect((await stub.executorSaw("hang")).runs).toBe(1);
  });
});
