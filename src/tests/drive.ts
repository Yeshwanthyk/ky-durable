import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import type { PiOperationResult, PiReceipt } from "agents/harness/pi";
import { expect } from "vitest";
import type { PiServerMessage } from "../protocol";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../view";
import {
  decodeObjectFrame,
  type MachineFacts,
  PAIRING_HEADER,
  PROTOCOL,
  RUNNER_PATH,
  type RunCommand,
  type RunnerCommand,
  type RunnerReport
} from "../machines/runner-protocol";
import { ASSERTION } from "../access";
import { FakeAccess } from "./fake-access";
import { decodeServerFrame } from "./frames";
import { agents, EXECUTOR_TOKEN, EXECUTOR_URL, type PiAgent } from "./stack";

/**
 * Drives ky's real Worker the way its clients do: the browser's WebSocket
 * through the Worker's fetch, signed in by the fake Access, and pi's harness
 * inside the object for what only the server sees. The Worker sends every
 * runner to the one agent "me", so a test's runner dials its own agent
 * object straight; sockets.test.ts checks the Worker's route.
 */

const ORIGIN = "https://ky.test";

/** Fetch through ky's Worker as Access lets the owner through, at ky's address or another; an empty assertion header is signed out. */
export async function call(path: string, init: RequestInit = {}, origin = ORIGIN): Promise<Response> {
  const headers = new Headers(init.headers);

  if (!headers.has(ASSERTION)) headers.set(ASSERTION, await new FakeAccess().sign());

  return SELF.fetch(`${origin}${path}`, { ...init, headers });
}

/** A pairing code, as the signed-in user makes one in Settings. */
export async function pairingCode(): Promise<{ code: string; expiresAt: number }> {
  const response = await call("/api/runners/codes", { method: "POST" });
  expect(response.status).toBe(200);

  return response.json();
}

/**
 * Pair as a runner does, signed in with nothing, from the address `from`; a
 * fresh one by default, so only a test that means to meets the rate limit.
 */
export function pair(body: { code: string; name: string; facts: object }, from: string = crypto.randomUUID()): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/runners/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": from },
    body: JSON.stringify(body)
  });
}

/** A machine token for `machine`, from a code and a pairing. */
export async function machineToken(machine: string): Promise<string> {
  const response = await pair({ code: (await pairingCode()).code, name: machine, facts: FACTS });
  expect(response.status).toBe(200);

  return (await response.json<{ token: string }>()).token;
}

/** Accept the WebSocket a fetch upgraded to. */
function accepted(response: Response): WebSocket {
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();

  return socket;
}

/** A WebSocket to the agent `name`, as the browser opens it (`?session=`), at ky's address or another. */
export async function connect(name: string, query = "", origin = ORIGIN): Promise<WebSocket> {
  return accepted(await call(`/agents/pi-agent/${name}${query}`, { headers: { Upgrade: "websocket" } }, origin));
}

/** The machine's pairing on the agent `name`, as `POST /api/runners/pair` leaves one; a new one if it has none. */
export function pairing(name: string, machine: string): Promise<string> {
  return inside(name, (instance, state) => {
    const [row] = state.storage.sql.exec<{ pairing: string | null }>("SELECT pairing FROM ky_machines WHERE name = ?", machine).toArray();

    if (row?.pairing) return row.pairing;
    const fresh = crypto.randomUUID();
    instance.machines.paired(machine, FACTS, fresh);

    return fresh;
  });
}

/**
 * A runner's WebSocket to the agent `name`, as the machine `machine`, past
 * the Worker's route to "me": with the header the Worker adds, naming the
 * machine's pairing, or `as`.
 */
export async function connectRunner(name: string, machine: string, as?: string): Promise<WebSocket> {
  const headers = { Upgrade: "websocket", [PAIRING_HEADER]: as ?? (await pairing(name, machine)) };

  return accepted(await agent(name).fetch(new Request(`${ORIGIN}${RUNNER_PATH}${machine}`, { headers })));
}

/** A Mac with Claude Code signed in, as ky-runner reports one. */
export const FACTS: MachineFacts = {
  os: "darwin",
  chrome: false,
  repos: [],
  agents: { claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } },
  ports: [],
  kind: "computer"
};

export type Follower = {
  view: () => PiSessionView;
  frames: PiServerMessage[];
  until: (check: () => boolean) => Promise<void>;
};

/** Folds every `events` frame into a view, as the browser hook does. */
export function follow(socket: WebSocket): Follower {
  let view: PiSessionView = EMPTY_VIEW;
  const frames: PiServerMessage[] = [];
  const waiters: Array<() => void> = [];

  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) return;

    const message = decodeServerFrame(event.data);

    if (message === undefined) return;
    frames.push(message);

    if (message.type === "events") view = reduceEvents(view, message.events);

    for (const waiter of waiters.splice(0)) waiter();
  });

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }

    if (!check()) throw new Error("Condition never held");
  };

  return { view: () => view, frames, until };
}

/** Whether a view has a message with text containing `text`. */
export function shows(view: PiSessionView, text: string): boolean {
  return view.messages.some((message) =>
    message.parts.some((part) => part.type === "text" && part.text.includes(text))
  );
}

/** The agent object named `name`. */
export function agent(name: string): DurableObjectStub<PiAgent> {
  return agents(env).getByName(name);
}

/** Run `work` inside the agent object, on its real composition and storage. */
export function inside<T>(name: string, work: (agent: PiAgent, state: DurableObjectState) => Promise<T> | T): Promise<T> {
  return runInDurableObject(agent(name), (instance: PiAgent, state) => work(instance, state));
}

/**
 * Connect the stack's fake Executor as Settings does; its tools are installed when this resolves. The fake's counts
 * start over after, so a test sees only its own calls.
 */
export async function connectExecutor(name: string): Promise<void> {
  await inside(name, async (instance) => {
    expect(await instance.executor.connect(EXECUTOR_URL, EXECUTOR_TOKEN)).toEqual({});
    instance.boundary.executorFake.sessions = 0;
  });
}

/** Prompt the root session and wait; the result without its transcript. */
export async function prompt(name: string, text: string): Promise<Omit<PiOperationResult, "messages">> {
  return inside(name, async (instance) => {
    const { messages: _messages, ...result } = await instance.harness.prompt(text);

    return result;
  });
}

/**
 * Prompt the root session and wait; the answer's text, and whether the last tool it called failed. The fake models
 * see a tool's result as text either way, as the chat-completions wire carries no isError, so this reads the
 * transcript.
 */
export async function promptTool(name: string, text: string): Promise<{ text?: string; failed?: boolean }> {
  return inside(name, async (instance) => {
    const { text: answer, messages } = await instance.harness.prompt(text);
    const result = messages.flatMap((entry) => entry.model ?? []).findLast((message) => message.role === "toolResult");

    return { text: answer, failed: result?.isError };
  });
}

export function submit(name: string, text: string): Promise<PiReceipt> {
  return inside(name, (instance) => instance.harness.submit(text, {}));
}

export function wait(name: string, operationId: string): Promise<PiOperationResult> {
  return inside(name, (instance) => instance.harness.wait(operationId, {}));
}

/** Resolve once `check` holds, polling. */
export async function until(check: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Never happened: ${what}`);
}

/** Resolve once the gate tools have started `runs` times. */
export async function gateStarted(name: string, runs: number): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if ((await agent(name).gateRuns()) >= runs) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("The gate tool never started");
}

/** A session's view, the root's by default, folded from a fresh snapshot as a client joining now gets it. */
export function snapshotView(name: string, session?: string): Promise<PiSessionView> {
  return inside(name, async (instance) => {
    const stream = await instance.harness.session(session).events();
    await stream.stop();

    return reduceEvents(EMPTY_VIEW, [stream.snapshot]);
  });
}

/** Resolve once the root session shows a message containing `text`. */
export async function said(name: string, text: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (shows(await snapshotView(name), text)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`The main agent never said ${JSON.stringify(text)}`);
}

/** The feed's delegated tasks, as the task list shows them. */
export function tasks(name: string): Promise<Array<{ kind: string; worker: string; status: string }>> {
  return inside(name, (instance) =>
    instance.feed.list().map(({ kind, worker, status }) => ({ kind, worker, status }))
  );
}

export type FakeRunner = {
  socket: WebSocket;
  commands: RunnerCommand[];
  /** The next command, acknowledged as the runner does. */
  next: () => Promise<RunnerCommand>;
  /** The next command, which must be a run. */
  run: () => Promise<RunCommand>;
  send: (report: RunnerReport) => void;
};

/**
 * A runner socket speaking the runner protocol by hand, for the worker side
 * of machine tasks. The CLI harness drives the real `ky runner run`.
 */
export async function runner(name: string, machine = "mac", facts: MachineFacts = FACTS): Promise<FakeRunner> {
  const socket = await connectRunner(name, machine);
  const commands: RunnerCommand[] = [];

  socket.addEventListener("message", (event) => {
    // The object also sends the Agents SDK's handshake on this socket; decoding skips it.
    const frame = decodeObjectFrame(String(event.data));

    if (frame !== undefined && "seq" in frame) commands.push(frame);
  });

  const send: FakeRunner["send"] = (report) => socket.send(JSON.stringify(report));
  send({ type: "hello", protocol: PROTOCOL, version: "test", active: [], facts });

  const next = async () => {
    for (let i = 0; i < 250 && commands.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const command = commands.shift();

    if (!command) throw new Error("The runner was sent nothing");
    send({ type: "ack", seq: command.seq });

    return command;
  };

  const run = async () => {
    const command = await next();

    if (command.type !== "run") throw new Error(`The runner was sent ${command.type}, not run`);

    return command;
  };

  return { socket, commands, next, run, send };
}
