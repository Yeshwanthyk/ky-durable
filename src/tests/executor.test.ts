import { describe, expect, it } from "vitest";
import { inside, prompt, promptTool, submit, until } from "./drive";

/** What the fake Executor saw: how often `code` ran, cancellations, sessions opened. */
function executorSaw(name: string, code: string): Promise<{ runs: number; cancelled: number; sessions: number }> {
  return inside(name, ({ boundary: { executorFake } }) => ({
    runs: executorFake.runs.get(code) ?? 0,
    cancelled: executorFake.cancelled,
    sessions: executorFake.sessions
  }));
}

describe("executor tools over MCP", () => {
  it("runs a program once and answers with its result", async () => {
    const name = crypto.randomUUID();

    expect((await prompt(name, "executor hello")).text).toBe("tool said: ran 1");
    expect(await executorSaw(name, "hello")).toEqual({ runs: 1, cancelled: 0, sessions: 1 });
  });

  it("never runs a program again when its response is lost after it ran", async () => {
    const name = crypto.randomUUID();

    expect(await promptTool(name, "executor lose-response")).toEqual({
      text: expect.stringMatching(/^tool said: Executor call failed: .*Network connection lost/),
      failed: true
    });
    expect((await executorSaw(name, "lose-response")).runs).toBe(1);
  });

  it("retries once on a fresh session when Executor expired the old one", async () => {
    const name = crypto.randomUUID();
    await prompt(name, "executor first");
    await inside(name, (agent) => agent.boundary.executorFake.open.clear());

    expect((await prompt(name, "executor second")).text).toBe("tool said: ran 1");
    expect(await executorSaw(name, "second")).toEqual({ runs: 1, cancelled: 0, sessions: 2 });
  });

  it("retries once when the connection cannot be made, and reports a second failure", async () => {
    const once = crypto.randomUUID();
    await inside(once, (agent) => {
      agent.boundary.executorFake.refuseConnects = 1;
    });
    expect((await prompt(once, "executor once")).text).toBe("tool said: ran 1");

    const never = crypto.randomUUID();
    await inside(never, (agent) => {
      agent.boundary.executorFake.refuseConnects = 2;
    });
    expect(await promptTool(never, "executor never")).toEqual({ text: expect.stringMatching(/^tool said: Executor call failed:/), failed: true });
    expect((await executorSaw(never, "never")).runs).toBe(0);
  });

  it("does not retry when Executor refuses the token", async () => {
    const name = crypto.randomUUID();
    await inside(name, (agent) => {
      agent.boundary.executorFake.token = "another-token";
    });

    expect(await promptTool(name, "executor refused")).toEqual({ text: expect.stringMatching(/^tool said: Executor call failed:/), failed: true });
    expect(await inside(name, (agent) => agent.boundary.executorFake.unauthorized)).toBe(1);
    expect((await executorSaw(name, "refused")).runs).toBe(0);
  });

  it("cancels the call at Executor when the turn is stopped", async () => {
    const name = crypto.randomUUID();
    await submit(name, "executor hang");
    await until(async () => (await executorSaw(name, "hang")).runs === 1, "the program started");

    await inside(name, (agent) => agent.harness.session().abort());
    await until(async () => (await executorSaw(name, "hang")).cancelled === 1, "Executor saw the cancel");
    expect((await executorSaw(name, "hang")).runs).toBe(1);
  });
});
