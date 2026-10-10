import { evictDurableObject } from "cloudflare:test";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { HandledSeqs } from "../../runner/handled.ts";
import { Runner, type AgentProcess, type Launch, type Link, type ProcessEvents } from "../../runner/runner.ts";
import { type CodexCreds, decodeObjectFrame, OUTDATED, PROTOCOL, REPLACED, type MachineFacts, type RunCreds } from "../runner-protocol";
import type { TaskRow } from "../tasks";
import { agent, connectRunner, FACTS, inside, prompt, snapshotView } from "./drive";

/**
 * The machine protocol end to end: the real runner logic (runner/runner.ts)
 * on a real WebSocket to the real PiAgent, with a
 * scripted `claude` or `codex` in place of the binary. The wire between them can hold or drop the runner's frames,
 * so each test replays one counterexample from
 * explainers/ky-architecture/quint/runner_protocol.qnt step by step.
 */

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
class FakeClaude implements AgentProcess {
  readonly resumed: string | null;
  /** The task token in its env, KY_TASK_TOKEN. */
  readonly taskToken: string;
  readonly prompts: string[] = [];
  /** Prompts written after it was told to stop; they die with it. */
  readonly afterStop: string[] = [];
  interrupted = false;
  #exited = false;
  /** How many prompts it has taken in. */
  #taken = 0;
  readonly #events: ProcessEvents;

  constructor(resumed: string | null, taskToken: string, events: ProcessEvents) {
    this.resumed = resumed;
    this.taskToken = taskToken;
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

  renew(): void {}

  session(id: string): void {
    this.#emit({ type: "system", subtype: "init", session_id: id });
  }

  /**
   * End a turn that took in the prompts up to `upTo` (all written so far by
   * default): each is echoed, as --replay-user-messages does, then one result.
   */
  answer(text: string, upTo = this.prompts.length): void {
    for (; this.#taken < upTo; this.#taken++) {
      this.#emit({ type: "user", isReplay: true, message: { role: "user", content: this.prompts[this.#taken]! } });
    }

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

  #emit(event: Record<string, string | boolean | { role: "user"; content: string }>): void {
    if (!this.#exited) this.#events.line(JSON.stringify(event));
  }
}

/** A `codex exec --json` stand-in: one turn, on the prompt it was given before stdin closed. */
class FakeCodex implements AgentProcess {
  readonly resumed: string | null;
  /** The task token in its env, KY_TASK_TOKEN. */
  readonly taskToken: string;
  /** The ChatGPT login it started with, and each one it was handed since. */
  readonly creds: RunCreds | undefined;
  readonly renewed: CodexCreds[] = [];
  prompt = "";
  interrupted = false;
  #exited = false;
  readonly #events: ProcessEvents;

  constructor({ session, taskToken, creds }: Launch, events: ProcessEvents) {
    this.resumed = session;
    this.taskToken = taskToken;
    this.creds = creds;
    this.#events = events;
  }

  write(text: string): void {
    this.prompt += text;
  }

  end(): void {}

  interrupt(): void {
    this.interrupted = true;
    this.#exit(130);
  }

  renew(codex: CodexCreds): void {
    this.renewed.push(codex);
  }

  /** Start its turn in `thread`. */
  start(thread: string): void {
    this.#emit({ type: "thread.started", thread_id: thread });
    this.#emit({ type: "turn.started" });
  }

  /** End its turn saying `text`, and exit, as `codex exec` does. */
  answer(text: string): void {
    this.#emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
    this.#emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    this.#exit(0);
  }

  #exit(code: number): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#events.exit(code, "");
  }

  #emit(event: Record<string, string | { id: string; type: string; text: string } | Record<string, number>>): void {
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
  readonly #facts: MachineFacts;
  readonly claudes: FakeClaude[] = [];
  readonly codexes: FakeCodex[] = [];
  runner: Runner;
  wire: Wire | undefined;

  constructor(object: string, facts: MachineFacts = FACTS) {
    this.#object = object;
    this.#facts = facts;
    this.runner = this.#boot();
  }

  #boot(): Runner {
    return new Runner(
      (agent, _task, launch, events) => {
        if (agent === "codex") {
          const codex = new FakeCodex(launch, events);
          this.codexes.push(codex);

          return codex;
        }

        const claude = new FakeClaude(launch.session, launch.taskToken, events);
        this.claudes.push(claude);

        return claude;
      },
      () => {},
      // The same file across restarts, as on a real machine.
      new HandledSeqs(`/tmp/ky-runner-test/${this.#object}/handled.json`, `https://example.com ${this.#object}`),
      "test",
      () => this.#facts
    );
  }

  /** Dial the object; `mode` decides what happens to what the runner sends. */
  async connect(mode: "pass" | "hold" | "drop" = "pass"): Promise<Wire> {
    const socket = await connectRunner(this.#object, "mac");
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

  async codex(index: number): Promise<FakeCodex> {
    await until(`codex #${index + 1} to start`, () => this.codexes.length > index);

    return this.codexes[index]!;
  }
}

/** A fresh object and its machine, not yet connected. */
type Fixture = { readonly object: string; readonly mac: Mac };

function fixture(facts?: MachineFacts): Fixture {
  const object = crypto.randomUUID();

  return { object, mac: new Mac(object, facts) };
}

/** A fresh object with its machine connected. */
async function online(facts?: MachineFacts): Promise<Fixture> {
  const machine = fixture(facts);
  await machine.mac.connect();

  return machine;
}

/** A machine that runs Codex as well as Claude Code. */
const WITH_CODEX: MachineFacts = { ...FACTS, agents: { ...FACTS.agents, codex: { installed: true, signedIn: true } } };

/** The main agent runs "build it" on the mac, as the machine's own agent or `as` one; returns the task id. */
async function start(object: string, as?: "codex"): Promise<string> {
  const result = await prompt(object, as ? `tool machine {"action":"run","machine":"mac","agent":"${as}","prompt":"build it"}` : "machine build it");
  const id = /Started task (\S+) on mac/.exec(result.text ?? "")?.[1];

  if (!id) throw new Error(`No task started: ${result.text}`);

  return id;
}

/** The reports a conversation, the main one by default, was given about a task, in order. */
async function reports(object: string, id: string, session?: string): Promise<string[]> {
  const view = await snapshotView(object, session);

  return view.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .filter((text) => text.startsWith("[machine mac,") && text.includes(`task ${id} `));
}

/** The task as the task list shows it. */
function task(object: string, id: string): Promise<TaskRow | undefined> {
  return inside(object, (agent) => agent.feed.get(id));
}

async function status(object: string, id: string): Promise<string | undefined> {
  return (await task(object, id))?.status;
}

/** Stop a machine task, as the task list's stop button does. */
function stopTask(object: string, id: string): Promise<void> {
  return inside(object, async (agent) => {
    const row = agent.feed.get(id);

    if (row) await agent.machines.stop(row);
  });
}

/** Send a machine task a message, as the machine tool's send does. */
function sendTask(object: string, id: string, message: string): Promise<void> {
  return inside(object, (agent) => {
    const row = agent.feed.get(id);

    if (row) agent.machines.send(row, message);
  });
}

/** Commands the object holds for a machine until it acknowledges them. */
function inbox(object: string, machine: string): Promise<number[]> {
  return inside(object, (_agent, state) =>
    state.storage.sql
      .exec<{ seq: number }>("SELECT seq FROM ky_machine_inbox WHERE machine = ? ORDER BY seq", machine)
      .toArray()
      .map((row) => row.seq)
  );
}

const terminal = (value: string | undefined) => value === "done" || value === "failed" || value === "stopped";

describe("runner protocol: the Quint counterexamples", () => {
  // CE1 seqStopRace: stop() while the run's ack is in flight.
  it("stopRace: a stop racing the ack stops the run, with one report", async () => {
    const { object, mac } = await online();
    mac.wire!.mode = "hold";
    const id = await start(object);
    const claude = await mac.claude(0);

    await stopTask(object, id);
    mac.wire!.release();
    claude.session("s1");
    await settle();

    if (claude.interrupted) claude.exit(130);
    else claude.answer("built");

    await until("the task to end", async () => terminal(await status(object, id)));
    await settle();
    const said = await reports(object, id);
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("Stopped before it started");
    expect(await status(object, id)).toBe("stopped");
  });

  // CE2 seqHelloBeforeOutbox: a result made offline must beat the reconnect hello.
  it("helloBeforeOutbox: a result finished offline is reported once, as done", async () => {
    const { object, mac } = await online();
    const id = await start(object);
    const claude = await mac.claude(0);
    claude.session("s1");
    await until("the task to be working", async () => (await status(object, id)) === "working");

    mac.disconnect();
    claude.answer("built");
    await mac.connect();

    await until("a report", async () => (await reports(object, id)).length > 0);
    await settle();
    const said = await reports(object, id);
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("Interrupted");
    expect(await status(object, id)).toBe("done");
  });

  // CE3 seqDupExec: the ack is lost and the runner restarts; the redelivered run must not run again.
  it("dupExec: a run whose ack was lost runs once across a runner restart", async () => {
    const { object, mac } = await online();
    mac.wire!.mode = "drop";
    await start(object);
    await mac.claude(0);

    mac.restart();
    await mac.connect();
    await settle();

    expect(mac.claudes).toHaveLength(1);
  });

  // CE4 seqSteerIntoStop: a send after a stop must not go to the dying session.
  it("steerIntoStop: a message sent while stopping starts a new session after it", async () => {
    const { object, mac } = await online();
    const id = await start(object);
    const first = await mac.claude(0);
    first.session("s1");
    await until("the task to be working", async () => (await status(object, id)) === "working");

    await stopTask(object, id);
    await until("the stop to reach the runner", () => first.interrupted);
    await until("the stop to be acked", async () => (await inbox(object, "mac")).length === 0);
    await sendTask(object, id, "and this");
    await settle();
    expect(first.afterStop).toEqual([]);
    first.exit(130);

    const second = await mac.claude(1);
    expect(second.prompts).toEqual(["and this"]);
    expect(second.resumed).toBe("s1");

    second.session("s1");
    second.answer("did this");
    await until("the task to be done", async () => (await status(object, id)) === "done");
    await settle();
    expect(await reports(object, id)).toHaveLength(2);
  });

  // CE5 seqStuckQueued: everything the run said was lost with the socket; the task must not stay queued.
  it("stuckQueued: a task whose reports were lost ends instead of staying queued", async () => {
    const { object, mac } = await online();
    const id = await start(object);
    const claude = await mac.claude(0);
    await until("the run to be acked", async () => (await inbox(object, "mac")).length === 0);

    mac.wire!.mode = "drop";
    claude.session("s1");
    claude.answer("built");
    mac.disconnect();
    await mac.connect();
    await settle();
    mac.runner.keepalive();
    await settle();

    expect(await status(object, id)).toBe("failed");
    expect((await task(object, id))?.summary).toContain("Interrupted");
    expect(await reports(object, id)).toHaveLength(1);
  });

  // CE6 seqReorder: started offline, then a follow-up sent before the hello lands.
  it("reorder: turns reach Claude Code in the order they were sent", async () => {
    const { object, mac } = fixture();
    const id = await start(object);
    const wire = await mac.connect("hold");
    await sendTask(object, id, "second");
    await mac.claude(0);
    wire.release();
    await settle();

    expect(mac.claudes).toHaveLength(1);
    expect(mac.claudes[0]!.prompts).toEqual(["build it", "second"]);
  });
});

describe("runner protocol", () => {
  it("decodes runner frames: a malformed report closes the runner's socket", async () => {
    const { mac } = await online();
    mac.wire!.socket.send(JSON.stringify({ type: "ack", seq: "one" }));

    await until("the object to close the socket", () => !mac.wire!.open);
    expect(mac.wire!.closedBy).toBe(1008);
  });

  it("says goodbye to a runner of another protocol, and closes its socket as outdated", async () => {
    const socket = await connectRunner(crypto.randomUUID(), "old");
    const said: unknown[] = [];
    let closedBy: number | undefined;
    socket.addEventListener("message", (event) => {
      said.push(decodeObjectFrame(String(event.data)));
    });
    socket.addEventListener("close", (event) => {
      closedBy = event.code;
    });
    // A protocol 2 hello: no version, no facts.
    socket.send(JSON.stringify({ type: "hello", protocol: 2, active: [] }));

    await until("the object to close the socket", () => closedBy !== undefined);
    expect(closedBy).toBe(OUTDATED);
    expect(said).toContainEqual({ type: "goodbye", reason: expect.stringContaining("update ky-runner"), expected: PROTOCOL });
  });

  it("decodes commands: the runner ignores a run without a prompt", async () => {
    const { mac } = await online();
    mac.runner.message(JSON.stringify({ type: "run", seq: 1, task: "m-x", turn: 1, session: null }));
    await settle();

    expect(mac.claudes).toHaveLength(0);
  });

  it("refuses a run for an agent this machine does not have, and starts one that looks signed out", async () => {
    // Claude Code's login as last asked; it may have signed in since, and if not, it says so itself.
    const { mac } = await online({ ...FACTS, agents: { claude: { installed: true, signedIn: false }, codex: { installed: false, signedIn: false } } });
    mac.wire!.mode = "hold";
    const run = { type: "run", task: "m-x", turn: 1, prompt: "go", session: null, taskToken: "" };
    mac.runner.message(JSON.stringify({ ...run, seq: 1, agent: "codex" }));
    mac.runner.message(JSON.stringify({ ...run, seq: 2, task: "m-y", agent: "claude" }));

    expect(mac.codexes).toHaveLength(0);
    expect(mac.wire!.held.map((text) => JSON.parse(text))).toContainEqual(
      expect.objectContaining({ type: "result", task: "m-x", turn: 1, ok: false, agent: "codex", text: "Codex is not installed on this machine." })
    );
    expect((await mac.claude(0)).prompts).toEqual(["go"]);
  });

  it("answers a request to a port with an error: the machine shares none", async () => {
    const { mac } = await online();
    mac.wire!.mode = "hold";
    mac.runner.message(JSON.stringify({ type: "http_request", id: "r1", port: 3000, method: "GET", path: "/", headers: {} }));

    expect(mac.wire!.held.map((text) => JSON.parse(text))).toEqual([
      { type: "http_error", id: "r1", message: "This machine shares no ports." }
    ]);
  });

  it("fences turns: a repeated result posts once, and a late step does not reopen the task", async () => {
    const { object, mac } = await online();
    const id = await start(object);
    await mac.claude(0);
    const result = JSON.stringify({ type: "result", task: id, turn: 1, ok: true, text: "built", session: null, agent: "claude" });
    mac.wire!.socket.send(result);
    mac.wire!.socket.send(result);
    mac.wire!.socket.send(JSON.stringify({ type: "step", task: id, turn: 1, text: "late" }));

    await until("a report", async () => (await reports(object, id)).length > 0);
    await settle();
    expect(await reports(object, id)).toHaveLength(1);
    expect(await status(object, id)).toBe("done");
  });

  it("stops a task the runner never got before it starts", async () => {
    const { object, mac } = fixture();
    const id = await start(object);
    await stopTask(object, id);

    await until("a report", async () => (await reports(object, id)).length > 0);
    expect((await reports(object, id))[0]).toContain("Stopped before it started");
    expect(await status(object, id)).toBe("stopped");

    await mac.connect();
    await settle();
    expect(mac.claudes).toHaveLength(0);
  });

  // Beyond the model: a second stop also stops the turn queued behind the first.
  it("drops a turn queued behind a stop when it is stopped too", async () => {
    const { object, mac } = await online();
    const id = await start(object);
    const first = await mac.claude(0);
    first.session("s1");
    await until("the task to be working", async () => (await status(object, id)) === "working");

    await stopTask(object, id);
    await until("the stop to be acked", async () => first.interrupted && (await inbox(object, "mac")).length === 0);
    await sendTask(object, id, "and this");
    await until("the message to be acked", async () => (await inbox(object, "mac")).length === 0);
    await stopTask(object, id);
    await until("the second stop to be acked", async () => (await inbox(object, "mac")).length === 0);
    first.exit(130);

    await until("the task to end", async () => terminal(await status(object, id)));
    await settle();
    expect(mac.claudes).toHaveLength(1);
    expect(await status(object, id)).toBe("stopped");
    const said = await reports(object, id);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Stopped. Dropped 1 queued message.");
  });

  // The stale keepalive the fixes surfaced: a hello sent before the run arrived must not end that run.
  it("keeps a run that a keepalive hello raced", async () => {
    const { object, mac } = await online();
    mac.wire!.mode = "hold";
    mac.runner.keepalive();
    const id = await start(object);
    const claude = await mac.claude(0);
    mac.wire!.release();
    await settle();
    expect(await status(object, id)).toBe("queued");

    claude.session("s1");
    claude.answer("built");
    await until("the task to be done", async () => (await status(object, id)) === "done");
    await settle();
    expect(await reports(object, id)).toHaveLength(1);
  });

  it("hands a Codex turn run with ky's login each refreshed one, and the turn queued behind it the newest", async () => {
    const { mac } = await online(WITH_CODEX);
    const login = (accessToken: string, expiresAt: number): CodexCreds => ({ accessToken, refreshToken: null, idToken: "id", accountId: "acct", expiresAt });
    const run = { type: "run", task: "m-c", turn: 1, prompt: "migrate", session: null, taskToken: "", agent: "codex" };
    mac.runner.message(JSON.stringify({ ...run, seq: 1, creds: { codex: login("first", 1) } }));
    const first = await mac.codex(0);
    first.start("t1");
    await settle();
    mac.runner.message(JSON.stringify({ ...run, seq: 2, turn: 2, prompt: "and test", session: "t1", creds: { codex: login("first", 1) } }));
    mac.runner.message(JSON.stringify({ type: "creds", seq: 3, task: "m-c", codex: login("second", 2) }));

    expect(first.creds).toEqual({ codex: login("first", 1) });
    expect(first.renewed).toEqual([login("second", 2)]);
    first.answer("migrated");
    expect((await mac.codex(1)).creds).toEqual({ codex: login("second", 2) });
  });

  it("keeps a refreshed ChatGPT login from a Codex turn signed in with the machine's own", async () => {
    const { mac } = await online(WITH_CODEX);
    mac.runner.message(JSON.stringify({ type: "run", seq: 1, task: "m-own", turn: 1, prompt: "go", session: null, taskToken: "", agent: "codex" }));
    const codex = await mac.codex(0);
    mac.runner.message(
      JSON.stringify({ type: "creds", seq: 2, task: "m-own", codex: { accessToken: "ky", refreshToken: null, idToken: "id", accountId: "acct", expiresAt: 2 } })
    );
    await settle();

    expect(codex.creds).toBeUndefined();
    expect(codex.renewed).toEqual([]);
  });

  it("runs two messages sent while a Codex turn runs in order, each in its own process resuming the thread", async () => {
    const { object, mac } = await online(WITH_CODEX);
    const id = await start(object, "codex");
    const first = await mac.codex(0);
    first.start("t1");
    await until("the task to be working", async () => (await status(object, id)) === "working");
    await sendTask(object, id, "and test it");
    await sendTask(object, id, "and ship it");
    await until("both messages to be acked", async () => (await inbox(object, "mac")).length === 0);
    expect(mac.codexes).toHaveLength(1);

    first.answer("built");
    const second = await mac.codex(1);
    expect([second.resumed, second.prompt]).toEqual(["t1", "and test it"]);
    second.start("t1");
    second.answer("tested");
    const third = await mac.codex(2);
    expect([third.resumed, third.prompt]).toEqual(["t1", "and ship it"]);
    third.start("t1");
    third.answer("shipped");
    // Each turn's new process gets the task's one token in its env, as KY_TASK_TOKEN.
    expect(first.taskToken).not.toBe("");
    expect([second.taskToken, third.taskToken]).toEqual([first.taskToken, first.taskToken]);

    await until("three reports", async () => (await reports(object, id)).length === 3);
    expect(await task(object, id)).toMatchObject({ status: "done", agent: "codex", turns: 3 });
    expect((await reports(object, id)).map((said) => said.split("\n").at(-1))).toEqual(["built", "tested", "shipped"]);
  });

  it("stops a Codex turn with a message queued behind it, and says once that it was dropped", async () => {
    const { object, mac } = await online(WITH_CODEX);
    const id = await start(object, "codex");
    const first = await mac.codex(0);
    first.start("t1");
    await until("the task to be working", async () => (await status(object, id)) === "working");
    await sendTask(object, id, "and this");
    await until("the message to be acked", async () => (await inbox(object, "mac")).length === 0);

    await stopTask(object, id);
    await until("the task to end", async () => terminal(await status(object, id)));
    await settle();
    expect(first.interrupted).toBe(true);
    expect(mac.codexes).toHaveLength(1);
    expect(await status(object, id)).toBe("stopped");
    const said = await reports(object, id);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Stopped. Dropped 1 queued message.");
  });

  it("stops a Codex follow-up started behind a finished turn, before its session is known", async () => {
    const { object, mac } = await online(WITH_CODEX);
    const id = await start(object, "codex");
    const first = await mac.codex(0);
    first.start("t1");
    await until("the task to be working", async () => (await status(object, id)) === "working");
    await sendTask(object, id, "and this");
    await until("the message to be acked", async () => (await inbox(object, "mac")).length === 0);
    first.answer("built");
    const second = await mac.codex(1);
    await until("the first turn's report", async () => (await reports(object, id)).length === 1);
    expect(await status(object, id)).toBe("done");

    await stopTask(object, id);
    await until("the follow-up to be interrupted", () => second.interrupted);
    await until("the task to be stopped", async () => (await status(object, id)) === "stopped");
  });

  it("reports a Codex result finished offline once the runner is back, as owed in its hello", async () => {
    const { object, mac } = await online(WITH_CODEX);
    const id = await start(object, "codex");
    const codex = await mac.codex(0);
    codex.start("t1");
    await until("the task to be working", async () => (await status(object, id)) === "working");

    mac.disconnect();
    codex.answer("built");
    expect(mac.runner.active()).toEqual([]);
    await mac.connect();

    await until("a report", async () => (await reports(object, id)).length > 0);
    await settle();
    const said = await reports(object, id);
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("Interrupted");
    expect(await task(object, id)).toMatchObject({ status: "done", session: "t1", turns: 1 });
  });

  it("keeps one socket per machine: a second runner's hello replaces the first", async () => {
    const { object, mac } = await online();
    const other = new Mac(object);
    await other.connect();

    await until("the object to close the first socket", () => !mac.wire!.open);
    expect(mac.wire!.closedBy).toBe(REPLACED);
    await start(object);
    await other.claude(0);
    await settle();
    expect(mac.claudes).toHaveLength(0);
  });
});

describe("runner protocol: reports reach the conversation that sent the work", () => {
  it("ends a turn that took in a message sent while it ran, with one report", async () => {
    const { object, mac } = await online();
    const id = await start(object);
    const claude = await mac.claude(0);
    claude.session("s1");
    await until("the task to be working", async () => (await status(object, id)) === "working");

    await sendTask(object, id, "and this");
    await until("the message to reach claude", () => claude.prompts.length === 2);
    // Claude Code takes the message into the running turn: one result answers both.
    claude.answer("built it, and this");

    await until("the task to be done", async () => (await status(object, id)) === "done");
    await until("the session to end", () => mac.runner.active().length === 0);
    const said = await reports(object, id);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("built it, and this");
  });

  it("waits for a message sent as a turn ended, which runs as its own turn", async () => {
    const { object, mac } = await online();
    const id = await start(object);
    const claude = await mac.claude(0);
    claude.session("s1");
    await sendTask(object, id, "and this");
    await until("the message to reach claude", () => claude.prompts.length === 2);

    claude.answer("built it", 1);
    await settle();
    expect(await status(object, id)).toBe("working");
    expect(await reports(object, id)).toHaveLength(0);

    claude.answer("did this");
    await until("the task to be done", async () => (await status(object, id)) === "done");
    const said = await reports(object, id);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("did this");
  });

  it("reports a task a side chat started to that side chat, not the main conversation", async () => {
    const { object, mac } = await online();
    const chat = await inside(object, (agent) => agent.newChat());
    const result = await inside(object, async (agent) => agent.harness.prompt("machine build it", { session: chat }));
    const id = /Started task (\S+) on mac/.exec(result.text ?? "")?.[1];
    expect(id).toBeDefined();
    const claude = await mac.claude(0);
    claude.session("s1");
    claude.answer("built");

    await until("the side chat's report", async () => (await reports(object, id!, chat)).length > 0);
    expect(await reports(object, id!)).toEqual([]);

    // The task list's own message goes to the side chat too: it sent the task's last turn.
    await sendTask(object, id!, "and this");
    const second = await mac.claude(1);
    second.answer("did this");
    await until("the second report", async () => (await reports(object, id!, chat)).length === 2);
    expect(await reports(object, id!)).toEqual([]);
  });

  it("runs a run queued before runs named their agent, as Claude Code's", async () => {
    const { object, mac } = await online();
    mac.disconnect();
    const id = await start(object);

    // The run as an object of the last protocol queued it: no agent.
    await inside(object, (_agent, state) => {
      state.storage.sql.exec("UPDATE ky_machine_inbox SET payload = json_remove(payload, '$.agent')");
    });

    await evictDurableObject(agent(object));

    const queued = await inside(object, (_agent, state) =>
      state.storage.sql.exec<{ payload: string }>("SELECT payload FROM ky_machine_inbox").toArray().map((row) => JSON.parse(row.payload))
    );

    expect(queued).toMatchObject([{ type: "run", task: id, agent: "claude" }]);

    await mac.connect();
    (await mac.claude(0)).answer("built");
    await until("the task to be done", async () => (await status(object, id)) === "done");
  });

  it("posts a report a restart cut off once the object starts again", async () => {
    const { object, mac } = await online();
    const id = await start(object);
    (await mac.claude(0)).answer("built");
    await until("the report", async () => (await reports(object, id)).length === 1);

    // A later turn closed, and the object stopped before posting its report.
    await inside(object, (_agent, state) => {
      state.storage.sql.exec(
        "INSERT INTO ky_machine_reports (task, turn, session, text) VALUES (?, 2, ?, ?)",
        id,
        ROOT_SESSION,
        `[machine mac, task ${id} "build it" finished, no reply needed unless the user is waiting on it]\ncut off`
      );
    });
    mac.disconnect();
    await evictDurableObject(agent(object));

    await until("the cut-off report", async () => (await reports(object, id)).length === 2);
    expect((await reports(object, id))[1]).toContain("cut off");
    expect(await inside(object, (_agent, state) => state.storage.sql.exec("SELECT * FROM ky_machine_reports").toArray())).toEqual([]);
  });
});
