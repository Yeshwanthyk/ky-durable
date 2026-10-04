import { env } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { describe, expect, it } from "vitest";
import type { PiSessionView } from "../view";

/** Resolve once the root session's view has a message whose text contains `text`. */
async function said(stub: DurableObjectStub<PiHarnessTestObject>, text: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    // SAFETY: snapshotView returns a folded PiSessionView as JSON.
    const view = JSON.parse(await stub.snapshotView()) as PiSessionView;

    const found = view.messages.some((message) =>
      message.parts.some((part) => part.type === "text" && part.text.includes(text))
    );

    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`The main agent never said ${JSON.stringify(text)}`);
}

type PiHarnessTestObject = import("./worker").PiHarnessTestObject;

type RunCommand = { type: string; seq: number; task: string };

/** Connect as the runner "mac"; returns its socket and the runs it has been sent so far. */
async function runner(name: string): Promise<{ socket: WebSocket; runs: RunCommand[]; next: () => Promise<RunCommand> }> {
  const response = await routeAgentRequest(
    new Request(`https://example.com/agents/pi-harness-test/${name}?runner=mac`, {
      headers: { Upgrade: "websocket" }
    }),
    env
  );

  // SAFETY: the upgrade answered 101 with a socket, as in sockets.test.ts.
  const socket = response!.webSocket as WebSocket;
  socket.accept();
  const runs: RunCommand[] = [];
  socket.addEventListener("message", (event) => {
    // SAFETY: the object sends this socket RunnerCommands and the agents handshake, told apart by type.
    const command = JSON.parse(String(event.data)) as RunCommand;

    if (command.type === "run") runs.push(command);
  });
  socket.send(JSON.stringify({ type: "hello", active: [] }));

  const next = async () => {
    for (let i = 0; i < 100 && runs.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const run = runs.shift()!;
    socket.send(JSON.stringify({ type: "ack", seq: run.seq }));

    return run;
  };

  return { socket, runs, next };
}

describe("delegated work leaves the main chat free", () => {
  it("answers the user while a subagent is still working", async () => {
    const stub = env.PI_HARNESS_TEST.getByName(crypto.randomUUID());

    const spawned = await stub.prompt("spawn worker gate");
    expect(spawned.text).toBe("tool said: Started worker.");
    await stub.gateStarted(1);

    // The subagent is stuck in its gate; the main agent must still answer.
    const reply = await stub.prompt("hello");
    expect(reply.text).toBe("echo: hello");
    expect(await stub.tasks()).toEqual([{ kind: "cloud", worker: "worker", status: "working" }]);

    await stub.release();
    await said(stub, "[subagent worker answered, no reply needed] tool said: released after 1 runs");
    expect(await stub.tasks()).toEqual([{ kind: "cloud", worker: "worker", status: "done" }]);
  });

  it("answers the user while a machine task is still working", async () => {
    const name = crypto.randomUUID();
    const stub = env.PI_HARNESS_TEST.getByName(name);

    const mac = await runner(name);

    const started = await stub.prompt("machine build it");
    expect(started.text).toMatch(/^tool said: Started task \S+ on mac\.$/);
    const run = await mac.next();

    // The runner has not answered; the main agent must still answer.
    const reply = await stub.prompt("hello");
    expect(reply.text).toBe("echo: hello");
    expect(await stub.tasks()).toEqual([{ kind: "machine", worker: "mac", status: "queued" }]);

    mac.socket.send(JSON.stringify({ type: "result", task: run.task, ok: true, text: "built", session: null }));
    await said(stub, `[machine mac, task ${run.task} "build it" finished`);
    expect(await stub.tasks()).toEqual([{ kind: "machine", worker: "mac", status: "done" }]);
    mac.socket.close();
  });

  it("hands a report to the main agent after its current tool, not after its whole run", async () => {
    const name = crypto.randomUUID();
    const stub = env.PI_HARNESS_TEST.getByName(name);
    const mac = await runner(name);
    await stub.prompt("machine build it");
    const run = await mac.next();

    // The main agent is stuck in a tool when the report arrives.
    const busy = await stub.submit("gate");
    await stub.gateStarted(1);
    mac.socket.send(JSON.stringify({ type: "result", task: run.task, ok: true, text: "built", session: null }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stub.release();

    // The same run answers the report; a follow-up would have waited for "tool said: released".
    const result = await stub.wait(busy.operationId);
    expect(result.text).toMatch(/^echo: \[machine mac, task \S+ "build it" finished/);
    mac.socket.close();
  });
});
