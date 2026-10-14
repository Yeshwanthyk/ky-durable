import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OUTDATED, PROTOCOL, REVOKED } from "../machines/runner-protocol";
import { FakeAccess } from "./fake-access";
import { agent, call, connect, connectExecutor, connectRunner, FACTS, follow, gateStarted, inside, machineToken, prompt, shows, submit, until, wait } from "./drive";
import { GPT_OSS } from "./stack";

const PICTURE = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } as const;

describe("the session WebSocket protocol", () => {
  it("sends a snapshot, then pi's events for a run started over the socket", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.frames.some((frame) => frame.type === "events"));

    expect(client.frames.find((frame) => frame.type === "hello")).toMatchObject({
      session: "1",
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "multiply" }),
        expect.objectContaining({ name: "machine" }),
        expect.objectContaining({ name: "subagent" }),
        expect.objectContaining({ name: "memory_note" }),
        expect.objectContaining({ name: "executor_skills" })
      ])
    });

    socket.send(JSON.stringify({ type: "submit", id: "c1", input: "multiply 7" }));
    await client.until(() => shows(client.view(), "tool said: 21"));
    await client.until(() => !client.view().running);

    expect(client.frames.find((frame) => frame.type === "result")).toMatchObject({
      id: "c1",
      result: { session: "1", accepted: true }
    });

    socket.close();
  });

  // A server-side dedupe guard: the frames are written by hand. test/web/ky.spec.ts drives the page's own resend.
  it("dedupes a submit resent with the same operation id after a dropped socket", async () => {
    const name = crypto.randomUUID();
    const submit = JSON.stringify({ type: "submit", id: "op-1", operationId: "op-1", input: "only once" });

    // The first socket delivers the submit, then drops before the page sees the answer.
    const first = await connect(name);
    const before = follow(first);
    await before.until(() => before.frames.some((frame) => frame.type === "events"));
    first.send(submit);
    await before.until(() => before.frames.some((frame) => frame.type === "result"));
    first.close();

    // The page reconnects and sends the unanswered submit again, with the same ids.
    const second = await connect(name);
    const after = follow(second);
    await after.until(() => after.frames.some((frame) => frame.type === "events"));
    second.send(submit);
    await after.until(() => after.frames.some((frame) => frame.type === "result"));
    expect(after.frames.find((frame) => frame.type === "result")).toMatchObject({
      id: "op-1",
      result: { operationId: "op-1", accepted: false }
    });

    await after.until(() => !after.view().running && after.view().messages.length >= 2);

    const texts = after.view().messages.map((message) =>
      message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
    );

    expect(texts).toEqual(["only once", "echo: only once"]);
    second.close();
  });

  it("sends images to the model and keeps them in the transcript", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.frames.some((frame) => frame.type === "events"));

    socket.send(
      JSON.stringify({ type: "submit", id: "i1", input: [PICTURE, { type: "text", text: "what is this" }] })
    );
    await client.until(() => shows(client.view(), "echo: what is this"));
    expect(client.frames.find((frame) => frame.type === "result")).toMatchObject({ id: "i1" });
    socket.close();

    // A page loaded later, after the object restarts, gets the image from storage.
    await evictDurableObject(agent(name));
    const later = follow(await connect(name));
    await later.until(() => later.view().messages.length > 0);

    expect(later.view().messages[0]).toMatchObject({
      role: "user",
      parts: [PICTURE, { type: "text", text: "what is this" }]
    });
  });

  it("refuses images the model can't read, or too many, too large, or the wrong kind", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.frames.some((frame) => frame.type === "events"));

    const refusal = async (id: string, input: object[]) => {
      socket.send(JSON.stringify({ type: "submit", id, input }));
      await client.until(() => client.frames.some((frame) => frame.type === "error" && frame.id === id));

      const error = client.frames.find((frame) => frame.type === "error" && frame.id === id);

      return error?.type === "error" ? error.message : "";
    };

    const image = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });

    expect(await refusal("many", Array.from({ length: 5 }, () => PICTURE))).toMatch(/at most 4 images/);
    expect(await refusal("large", [image("a".repeat(1_400_004))])).toMatch(/too large/);
    expect(await refusal("svg", [image("aGk=", "image/svg+xml")])).toMatch(/JPEG, PNG/);
    expect(await refusal("base64", [image("not base64!")])).toMatch(/base64/);

    expect(await refusal("empty", [])).toMatch(/one text part/);
    expect(
      await refusal("texts", [
        { type: "text", text: "one" },
        { type: "text", text: "two" }
      ])
    ).toMatch(/one text part/);

    socket.send(
      JSON.stringify({
        type: "set-model",
        id: "m1",
        purpose: "main",
        choice: { provider: "workers-ai", modelId: GPT_OSS, thinkingLevel: "off" }
      })
    );
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === "m1"));
    expect(await refusal("blind", [PICTURE])).toMatch(/^GPT OSS 120B can't read images/);
    expect(client.view().messages).toEqual([]);
    socket.close();
  });

  it("gives a client that joins mid-run the running state", async () => {
    const name = crypto.randomUUID();
    const receipt = await submit(name, "gate");
    await gateStarted(name, 1);

    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.view().running);
    expect(client.view().tools.map((tool) => tool.name)).toEqual(["gate"]);
    expect(client.view().tools[0]?.output).toBe("run 1\n");

    await agent(name).release();
    await wait(name, receipt.operationId);
    await client.until(() => !client.view().running);

    expect(client.view().messages.at(-1)?.parts[0]).toEqual({
      type: "text",
      text: "tool said: released after 1 runs"
    });

    socket.close();
  });

  it("keeps serving a hibernated socket after the object is evicted", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.frames.some((frame) => frame.type === "events"));

    await evictDurableObject(agent(name));

    const snapshots = () =>
      client.frames.filter((frame) => frame.type === "events" && frame.events[0]?.type === "snapshot").length;

    const before = snapshots();
    // The next call restarts the object; its start re-watches the socket.
    const result = await prompt(name, "after hibernation");
    expect(result.text).toBe("echo: after hibernation");
    await client.until(() => shows(client.view(), "echo: after hibernation"));
    expect(snapshots()).toBe(before + 1);
    socket.close();
  });
});

describe("the runner's WebSocket", () => {
  it("goes through the Worker, with its own machine token, to the one agent, as the machine its path names", async () => {
    const machine = `route-${crypto.randomUUID().slice(0, 8)}`;
    const other = `route-${crypto.randomUUID().slice(0, 8)}`;
    const [token, othersToken] = [await machineToken(machine), await machineToken(other)];
    const upgrade = { Upgrade: "websocket" };
    const as = (authorization: string) => call(`/runner/${machine}`, { headers: { ...upgrade, Authorization: authorization } });

    // No token, the user's sign-in, a made-up token, and another machine's: none opens this machine's socket.
    expect((await as("")).status).toBe(401);
    expect((await as(`Bearer ${await new FakeAccess().sign()}`)).status).toBe(401);
    expect((await as(`Bearer ${"0".repeat(64)}`)).status).toBe(401);
    expect((await as(`Bearer ${othersToken}`)).status).toBe(401);

    const response = await as(`Bearer ${token}`);
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, version: "test", active: [], facts: FACTS }));

    await until(() => inside("me", (instance) => instance.machines.online(machine)), `${machine} online on "me"`);
    socket.close();
  });

  it("turns away a path that names no machine, and a request that is not a socket", async () => {
    for (const path of ["/runner/Mac", "/runner/mac/", "/runner/mac/x", "/runner/"]) {
      expect((await call(path, { headers: { Upgrade: "websocket" } })).status, path).toBe(404);
    }

    const machine = `plain-${crypto.randomUUID().slice(0, 8)}`;
    const token = await machineToken(machine);
    expect((await call(`/runner/${machine}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(426);
  });

  it("keeps no machine for a socket whose machine was never paired, or that never says a valid hello", async () => {
    const name = crypto.randomUUID();
    const stranger = await connectRunner(name, "stranger", crypto.randomUUID());
    const turnedAway = new Promise<number>((resolve) => stranger.addEventListener("close", (event) => resolve(event.code)));
    expect(await turnedAway).toBe(REVOKED);

    const silent = await connectRunner(name, "silent");
    silent.close();
    const old = await connectRunner(name, "old");

    const closed = new Promise<number>((resolve) => {
      old.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });

    old.send(JSON.stringify({ type: "hello", protocol: PROTOCOL - 1, active: [] }));
    expect(await closed).toBe(OUTDATED);

    await until(async () => (await inside(name, (instance) => instance.machines.online("silent"))) === false, "silent offline");

    // Only pairing makes a machine: the two paired ones are listed, offline, and the stranger is not; the cloud machine comes with the deploy.
    const machines = await inside(name, (instance) => instance.machines.machines());
    expect(machines.map((machine) => [machine.name, machine.online])).toEqual([
      ["cloud", false],
      ["old", false],
      ["silent", false]
    ]);
  });

  it("leaves `?runner=` alone: the agent's path opens a session socket, not a machine's", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name, "?runner=mac");
    const client = follow(socket);
    await client.until(() => client.frames.some((frame) => frame.type === "hello"));

    expect((await inside(name, (instance) => instance.machines.machines())).map((machine) => machine.name)).toEqual(["cloud"]);
    socket.close();
  });
});
