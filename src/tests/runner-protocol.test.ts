import { env } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { describe, expect, it } from "vitest";
import { Runner, type ClaudeEvents, type ClaudeProcess, type Link } from "../../runner/runner.ts";
import type { PiSessionView } from "../view";

/**
 * The machine protocol end to end: the real runner logic (runner/runner.ts)
 * on a real WebSocket to the real object, with a scripted `claude` in place
 * of the binary. The wire between them can hold or drop the runner's frames,
 * so each test replays one counterexample from
 * explainers/ky-architecture/quint/runner_protocol.qnt step by step.
 */

type PiHarnessTestObject = import("./worker").PiHarnessTestObject;

type Stub = DurableObjectStub<PiHarnessTestObject>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `probe` holds. */
async function until(what: string, probe: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await probe()) return;
    await pause(20);
  }

  throw new Error(`Timed out waiting for ${what}`);
}

/** Let frames in flight land before checking that nothing more happens. */
const settle = () => pause(300);

/** A `claude -p` stand-in: the test decides what it says and when it exits. */
class FakeClaude implements ClaudeProcess {
  readonly resumed: string | null;
  readonly prompts: string[] = [];
  /** Prompts written after it was told to stop; they die with it. */
  readonly afterStop: string[] = [];
  interrupted = false;
  #exited = false;
  readonly #events: ClaudeEvents;

  constructor(resumed: string | null, events: ClaudeEvents) {
    this.resumed = resumed;
    this.#events = events;
  }

  write(line: string): void {
    // SAFETY: the runner writes stream-json user lines, { type: "user", message: { content } }.
    const { message } = JSON.parse(line) as { message: { content: string } };
    (this.interrupted ? this.afterStop : this.prompts).push(message.content);
  }

  end(): void {
    setTimeout(() => this.exit(0), 0);
  }

  interrupt(): void {
    this.interrupted = true;
  }

  session(id: string): void {
    this.#emit({ type: "system", subtype: "init", session_id: id });
  }

  answer(text: string): void {
    this.#emit({ type: "result", subtype: "success", is_error: false, result: text });
  }

  exit(code: number): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#events.exit(code, "");
  }

  /** The process died with the runner: it says nothing more. */
  kill(): void {
    this.#exited = true;
  }

  #emit(event: Record<string, string | boolean>): void {
    if (!this.#exited) this.#events.line(JSON.stringify(event));
  }
}

/** One socket from the runner to the object; it can hold or drop what the runner sends. */
class Wire {
  readonly socket: WebSocket;
  readonly held: string[] = [];
  mode: "pass" | "hold" | "drop";
  open = true;
  /** The close code, when the object closed it. */
  closedBy: number | undefined;
  readonly link: Link = {
    send: (text) => {
      if (!this.open) return false;

      if (this.mode === "pass") this.socket.send(text);
      else if (this.mode === "hold") this.held.push(text);

      return true;
    }
  };

  constructor(socket: WebSocket, mode: "pass" | "hold" | "drop") {
    this.socket = socket;
    this.mode = mode;
  }

  /** Deliver what was held, in order, and pass from now on. */
  release(): void {
    this.mode = "pass";

    for (const text of this.held.splice(0)) this.socket.send(text);
  }
}

/** A machine named "mac": a runner, its sessions, and its socket when connected. */
class Mac {
  readonly #object: string;
  readonly claudes: FakeClaude[] = [];
  runner: Runner;
  wire: Wire | undefined;

  constructor(object: string) {
    this.#object = object;
    this.runner = this.#boot();
  }

  #boot(): Runner {
    return new Runner(
      (_task, session, events) => {
        const claude = new FakeClaude(session, events);
        this.claudes.push(claude);

        return claude;
      },
      () => {}
    );
  }

  /** Dial the object; `mode` decides what happens to what the runner sends. */
  async connect(mode: "pass" | "hold" | "drop" = "pass"): Promise<Wire> {
    const response = await routeAgentRequest(
      new Request(`https://example.com/agents/pi-harness-test/${this.#object}?runner=mac`, {
        headers: { Upgrade: "websocket" }
      }),
      env
    );

    // SAFETY: the upgrade answered 101 with a socket, as in sockets.test.ts.
    const socket = response!.webSocket as WebSocket;
    socket.accept();
    const wire = new Wire(socket, mode);
    const runner = this.runner;
    socket.addEventListener("message", (event) => {
      if (wire.open) runner.message(String(event.data));
    });
    socket.addEventListener("close", (event) => {
      if (!wire.open) return;
      wire.open = false;
      wire.closedBy = event.code;
      runner.closed(wire.link);
    });
    this.wire = wire;
    runner.open(wire.link);

    return wire;
  }

  /** The socket drops. What was held is lost unless `deliverHeld`. */
  disconnect(deliverHeld = false): void {
    const wire = this.wire!;

    if (deliverHeld) wire.release();
    wire.open = false;
    this.runner.closed(wire.link);
    wire.socket.close(1000, "test");
  }

  /** The runner process dies and starts again: its sessions and memory are gone. */
  restart(): void {
    if (this.wire?.open) this.disconnect();

    for (const claude of this.claudes) claude.kill();
    this.runner = this.#boot();
  }

  async claude(index: number): Promise<FakeClaude> {
    await until(`claude #${index + 1} to start`, () => this.claudes.length > index);

    return this.claudes[index]!;
  }
}

/** A fresh object and its machine, not yet connected. */
type Fixture = { readonly stub: Stub; readonly mac: Mac; readonly object: string };

function fixture(): Fixture {
  const object = crypto.randomUUID();

  return { stub: env.PI_HARNESS_TEST.getByName(object), mac: new Mac(object), object };
}

/** A fresh object with its machine connected. */
async function online(): Promise<Fixture> {
  const machine = fixture();
  await machine.mac.connect();

  return machine;
}

/** The main agent runs "build it" on the mac; returns the task id. */
async function start(stub: Stub): Promise<string> {
  const result = await stub.prompt("machine build it");
  const id = /Started task (\S+) on mac/.exec(result.text ?? "")?.[1];

  if (!id) throw new Error(`No task started: ${result.text}`);

  return id;
}

/** The reports the main agent was given about a task, in order. */
async function reports(stub: Stub, id: string): Promise<string[]> {
  // SAFETY: snapshotView returns a folded PiSessionView as JSON.
  const view = JSON.parse(await stub.snapshotView()) as PiSessionView;

  return view.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .filter((text) => text.startsWith("[machine mac,") && text.includes(`task ${id} `));
}

async function status(stub: Stub, id: string): Promise<string | undefined> {
  return (await stub.task(id))?.status;
}

const terminal = (value: string | undefined) => value === "done" || value === "failed" || value === "stopped";

describe("runner protocol: the Quint counterexamples", () => {
  // CE1 seqStopRace: stop() while the run's ack is in flight.
  it.fails("stopRace: a stop racing the ack stops the run, with one report", async () => {
    const { stub, mac } = await online();
    mac.wire!.mode = "hold";
    const id = await start(stub);
    const claude = await mac.claude(0);

    await stub.stopTask(id);
    mac.wire!.release();
    claude.session("s1");
    await settle();

    if (claude.interrupted) claude.exit(130);
    else claude.answer("built");

    await until("the task to end", async () => terminal(await status(stub, id)));
    await settle();
    const said = await reports(stub, id);
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("Stopped before it started");
    expect(await status(stub, id)).toBe("stopped");
  });

  // CE2 seqHelloBeforeOutbox: a result made offline must beat the reconnect hello.
  it.fails("helloBeforeOutbox: a result finished offline is reported once, as done", async () => {
    const { stub, mac } = await online();
    const id = await start(stub);
    const claude = await mac.claude(0);
    claude.session("s1");
    await until("the task to be working", async () => (await status(stub, id)) === "working");

    mac.disconnect();
    claude.answer("built");
    await mac.connect();

    await until("a report", async () => (await reports(stub, id)).length > 0);
    await settle();
    const said = await reports(stub, id);
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("Interrupted");
    expect(await status(stub, id)).toBe("done");
  });

  // CE3 seqDupExec: the ack is lost and the runner restarts; the redelivered run must not run again.
  it.fails("dupExec: a run whose ack was lost runs once across a runner restart", async () => {
    const { stub, mac } = await online();
    mac.wire!.mode = "drop";
    await start(stub);
    await mac.claude(0);

    mac.restart();
    await mac.connect();
    await settle();

    expect(mac.claudes).toHaveLength(1);
  });

  // CE4 seqSteerIntoStop: a send after a stop must not go to the dying session.
  it.fails("steerIntoStop: a message sent while stopping starts a new session after it", async () => {
    const { stub, mac } = await online();
    const id = await start(stub);
    const first = await mac.claude(0);
    first.session("s1");
    await until("the task to be working", async () => (await status(stub, id)) === "working");

    await stub.stopTask(id);
    await until("the stop to reach the runner", () => first.interrupted);
    await until("the stop to be acked", async () => (await stub.inbox("mac")).length === 0);
    await stub.sendTask(id, "and this");
    await settle();
    expect(first.afterStop).toEqual([]);
    first.exit(130);

    const second = await mac.claude(1);
    expect(second.prompts).toEqual(["and this"]);
    expect(second.resumed).toBe("s1");

    second.session("s1");
    second.answer("did this");
    await until("the task to be done", async () => (await status(stub, id)) === "done");
    await settle();
    expect(await reports(stub, id)).toHaveLength(2);
  });

  // CE5 seqStuckQueued: everything the run said was lost with the socket; the task must not stay queued.
  it.fails("stuckQueued: a task whose reports were lost ends instead of staying queued", async () => {
    const { stub, mac } = await online();
    const id = await start(stub);
    const claude = await mac.claude(0);
    await until("the run to be acked", async () => (await stub.inbox("mac")).length === 0);

    mac.wire!.mode = "drop";
    claude.session("s1");
    claude.answer("built");
    mac.disconnect();
    await mac.connect();
    await settle();
    mac.runner.keepalive();
    await settle();

    expect(await status(stub, id)).toBe("failed");
    expect((await stub.task(id))?.summary).toContain("Interrupted");
    expect(await reports(stub, id)).toHaveLength(1);
  });

  // CE6 seqReorder: started offline, then a follow-up sent before the hello lands.
  it.fails("reorder: turns reach Claude Code in the order they were sent", async () => {
    const { stub, mac } = fixture();
    const id = await start(stub);
    const wire = await mac.connect("hold");
    await stub.sendTask(id, "second");
    await mac.claude(0);
    wire.release();
    await settle();

    expect(mac.claudes).toHaveLength(1);
    expect(mac.claudes[0]!.prompts).toEqual(["build it", "second"]);
  });
});

describe("runner protocol", () => {
  it.fails("decodes runner frames: a malformed report closes the runner's socket", async () => {
    const { mac } = await online();
    mac.wire!.socket.send(JSON.stringify({ type: "ack", seq: "one" }));

    await until("the object to close the socket", () => !mac.wire!.open);
    expect(mac.wire!.closedBy).toBe(1008);
  });

  it.fails("decodes commands: the runner ignores a run without a prompt", async () => {
    const { mac } = await online();
    mac.runner.message(JSON.stringify({ type: "run", seq: 1, task: "m-x", turn: 1, session: null }));
    await settle();

    expect(mac.claudes).toHaveLength(0);
  });

  it.fails("fences turns: a repeated result posts once, and a late progress does not reopen the task", async () => {
    const { stub, mac } = await online();
    const id = await start(stub);
    await mac.claude(0);
    const result = JSON.stringify({ type: "result", task: id, turn: 1, ok: true, text: "built", session: null });
    mac.wire!.socket.send(result);
    mac.wire!.socket.send(result);
    mac.wire!.socket.send(JSON.stringify({ type: "progress", task: id, turn: 1, text: "late" }));

    await until("a report", async () => (await reports(stub, id)).length > 0);
    await settle();
    expect(await reports(stub, id)).toHaveLength(1);
    expect(await status(stub, id)).toBe("done");
  });

  it("stops a task the runner never got before it starts", async () => {
    const { stub, mac } = fixture();
    const id = await start(stub);
    await stub.stopTask(id);

    await until("a report", async () => (await reports(stub, id)).length > 0);
    expect((await reports(stub, id))[0]).toContain("Stopped before it started");
    expect(await status(stub, id)).toBe("stopped");

    await mac.connect();
    await settle();
    expect(mac.claudes).toHaveLength(0);
  });

  // The stale keepalive the fixes surfaced: a hello sent before the run arrived must not end that run.
  it("keeps a run that a keepalive hello raced", async () => {
    const { stub, mac } = await online();
    mac.wire!.mode = "hold";
    mac.runner.keepalive();
    const id = await start(stub);
    const claude = await mac.claude(0);
    mac.wire!.release();
    await settle();
    expect(await status(stub, id)).toBe("queued");

    claude.session("s1");
    claude.answer("built");
    await until("the task to be done", async () => (await status(stub, id)) === "done");
    await settle();
    expect(await reports(stub, id)).toHaveLength(1);
  });

  it.fails("keeps one socket per machine: a second runner's hello replaces the first", async () => {
    const { stub, mac, object } = await online();
    const other = new Mac(object);
    await other.connect();

    await until("the object to close the first socket", () => !mac.wire!.open);
    await start(stub);
    await other.claude(0);
    await settle();
    expect(mac.claudes).toHaveLength(0);
  });
});
