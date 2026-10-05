import { describe, expect, it } from "vitest";
import { agent, gateStarted, prompt, runner, said, submit, tasks, wait } from "./drive";

describe("delegated work leaves the main chat free", () => {
  it("answers the user while a subagent is still working", async () => {
    const name = crypto.randomUUID();

    const spawned = await prompt(name, "spawn worker gate");
    expect(spawned.text).toBe("tool said: Started worker.");
    await gateStarted(name, 1);

    // The subagent is stuck in its gate; the main agent must still answer.
    const reply = await prompt(name, "hello");
    expect(reply.text).toBe("echo: hello");
    expect(await tasks(name)).toEqual([{ kind: "cloud", worker: "worker", status: "working" }]);

    await agent(name).release();
    await said(name, "[subagent worker answered, no reply needed] tool said: released after 1 runs");
    expect(await tasks(name)).toEqual([{ kind: "cloud", worker: "worker", status: "done" }]);
  });

  it("answers the user while a machine task is still working", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);

    const started = await prompt(name, "machine build it");
    expect(started.text).toMatch(/^tool said: Started task \S+ on mac\.$/);
    const run = await mac.next();

    // The runner has not answered; the main agent must still answer.
    const reply = await prompt(name, "hello");
    expect(reply.text).toBe("echo: hello");
    expect(await tasks(name)).toEqual([{ kind: "machine", worker: "mac", status: "queued" }]);

    mac.send({ type: "result", task: run.task, ok: true, text: "built", session: null });
    await said(name, `build it" finished`);
    expect(await tasks(name)).toEqual([{ kind: "machine", worker: "mac", status: "done" }]);
    mac.socket.close();
  });

  it("hands a report to the main agent after its current tool, not after its whole run", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);
    await prompt(name, "machine build it");
    const run = await mac.next();

    // The main agent is stuck in a tool when the report arrives.
    const busy = await submit(name, "gate");
    await gateStarted(name, 1);
    mac.send({ type: "result", task: run.task, ok: true, text: "built", session: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await agent(name).release();

    // The same run answers the report; a follow-up would have waited for "tool said: released".
    const result = await wait(name, busy.operationId);
    expect(result.text).toMatch(/^echo: \[machine mac, task \S+ "(Named: )?build it" finished/);
    mac.socket.close();
  });
});
