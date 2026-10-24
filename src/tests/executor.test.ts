import { describe, expect, it } from "vitest";
import { connectExecutor, inside, prompt, promptTool, said, submit, until } from "./drive";
import { EXECUTOR_TOKEN, EXECUTOR_URL } from "./stack";

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
    await connectExecutor(name);

    expect((await prompt(name, "executor hello")).text).toBe("tool said: ran 1");
    expect(await executorSaw(name, "hello")).toEqual({ runs: 1, cancelled: 0, sessions: 1 });
  });

  it("never runs a program again when its response is lost after it ran", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);

    expect(await promptTool(name, "executor lose-response")).toEqual({
      text: expect.stringMatching(/^tool said: Executor call failed: .*Network connection lost/),
      failed: true
    });
    expect((await executorSaw(name, "lose-response")).runs).toBe(1);
  });

  it("retries once on a fresh session when Executor expired the old one", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    await prompt(name, "executor first");
    await inside(name, (agent) => agent.boundary.executorFake.open.clear());

    expect((await prompt(name, "executor second")).text).toBe("tool said: ran 1");
    expect(await executorSaw(name, "second")).toEqual({ runs: 1, cancelled: 0, sessions: 2 });
  });

  it("retries once when the connection cannot be made, and reports a second failure", async () => {
    const once = crypto.randomUUID();
    await connectExecutor(once);
    await inside(once, (agent) => {
      agent.boundary.executorFake.refuseConnects = 1;
    });
    expect((await prompt(once, "executor once")).text).toBe("tool said: ran 1");

    const never = crypto.randomUUID();

    await connectExecutor(never);
    await inside(never, (agent) => {
      agent.boundary.executorFake.refuseConnects = 2;
    });
    expect(await promptTool(never, "executor never")).toEqual({ text: expect.stringMatching(/^tool said: Executor call failed:/), failed: true });
    expect((await executorSaw(never, "never")).runs).toBe(0);
  });

  it("does not retry when Executor refuses the token", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    await inside(name, (agent) => {
      agent.boundary.executorFake.token = "another-token";
    });

    expect(await promptTool(name, "executor refused")).toEqual({ text: expect.stringMatching(/^tool said: Executor call failed:/), failed: true });
    expect(await inside(name, (agent) => agent.boundary.executorFake.unauthorized)).toBe(1);
    expect((await executorSaw(name, "refused")).runs).toBe(0);
  });

  it("cancels the call at Executor when the turn is stopped", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    await submit(name, "executor hang");
    await until(async () => (await executorSaw(name, "hang")).runs === 1, "the program started");

    await inside(name, (agent) => agent.harness.session().abort());
    await until(async () => (await executorSaw(name, "hang")).cancelled === 1, "Executor saw the cancel");
    expect((await executorSaw(name, "hang")).runs).toBe(1);
  });
});

describe("executor approvals in model mode", () => {
  const BROWSER = `${EXECUTOR_URL}?elicitation_mode=browser`;

  /** Connect with the browser-mode URL a ky may have saved. */
  async function connectBrowserUrl(name: string): Promise<void> {
    await inside(name, async (instance) => {
      expect(await instance.executor.connect(BROWSER, EXECUTOR_TOKEN)).toEqual({});
      instance.boundary.executorFake.sessions = 0;
    });
  }

  it("connects without elicitation_mode, and keeps the saved URL as it was", async () => {
    const name = crypto.randomUUID();
    await connectBrowserUrl(name);
    await prompt(name, "executor hello");

    const { urls, saved } = await inside(name, async (instance) => ({
      urls: instance.boundary.executorFake.connectedUrls,
      saved: (await instance.executor.view()).url
    }));

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => !new URL(url).searchParams.has("elicitation_mode"))).toBe(true);
    expect(saved).toBe(BROWSER);
  });

  it("passes a decline to Executor unchanged", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const args = { requestId: "request-9", response: { action: "decline" } };

    await prompt(name, `tool executor_resume ${JSON.stringify(args)}`);

    expect(await inside(name, (instance) => instance.boundary.executorFake.resumes)).toEqual([args]);
  });

  it("answers an approval asked in one session after the client reconnects", async () => {
    const name = crypto.randomUUID();
    await connectBrowserUrl(name);

    expect((await prompt(name, 'tool executor_execute {"code":"approve send mail to sam"}')).text).toMatch(
      /^tool said: \{"status":"approval-required","requestId":"request-1","message":"send mail to sam"\}/
    );
    // Executor forgets the session, as a new one after the Durable Object wakes.
    await inside(name, (instance) => instance.boundary.executorFake.open.clear());
    const [card] = await inside(name, (instance) => instance.approvals.pending());

    // The user's tap resumes it on a session of its own, which closes after.
    expect(await inside(name, (instance) => instance.approvals.onDecision(card!.id, "accept"))).toEqual({});
    await said(name, '{"status":"completed","result":"did send mail to sam"}');
    expect(await inside(name, (instance) => instance.boundary.executorFake.sessions)).toBe(2);
  });

  it("refuses a gate that asks for an approval or for input", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);

    const checks = await inside(name, async (instance) => [
      await instance.automations.checkGate("approve send mail"),
      await instance.automations.checkGate("ask which label")
    ]);

    expect(checks).toEqual([
      { kind: "error", text: "it asked for an approval or input; a gate may only read" },
      { kind: "error", text: "it asked for an approval or input; a gate may only read" }
    ]);
  });
});
