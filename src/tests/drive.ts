import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import type { PiOperationResult, PiReceipt } from "agents/harness/pi";
import { expect } from "vitest";
import type { PiServerMessage } from "../protocol";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../view";
import {
  decodeObjectFrame,
  type MachineFacts,
  PROTOCOL,
  RUNNER_PATH,
  type RunCommand,
  type RunnerCommand,
  type RunnerReport
} from "../runner-protocol";
import { decodeServerFrame } from "./frames";
import { agents, type PiAgent } from "./stack";

/**
 * Drives ky's real Worker the way its clients do: the browser's WebSocket
 * through the Worker's fetch, signed in with the test token, and pi's harness
 * inside the object for what only the server sees. The Worker sends every
 * runner to the one agent "me", so a test's runner dials its own agent
 * object straight; sockets.test.ts checks the Worker's route.
 */

export const TOKEN = "ky-stack-token";

const ORIGIN = "https://ky.test";

/** Fetch through ky's Worker, signed in with the bearer token. */
export function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);

  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${TOKEN}`);

  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

/** Accept the WebSocket a fetch upgraded to. */
function accepted(response: Response): WebSocket {
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();

  return socket;
}

/** A WebSocket to the agent `name`, as the browser opens it (`?session=`). */
export async function connect(name: string, query = ""): Promise<WebSocket> {
  return accepted(await call(`/agents/pi-agent/${name}${query}`, { headers: { Upgrade: "websocket" } }));
}

/** A runner's WebSocket to the agent `name`, as the machine `machine`, past the Worker's route to "me". */
export async function connectRunner(name: string, machine: string): Promise<WebSocket> {
  const request = new Request(`${ORIGIN}${RUNNER_PATH}${machine}`, { headers: { Upgrade: "websocket" } });

  return accepted(await agent(name).fetch(request));
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

/** Prompt the root session and wait; the result without its transcript. */
export async function prompt(name: string, text: string): Promise<Omit<PiOperationResult, "messages">> {
  return inside(name, async (instance) => {
    const { messages: _messages, ...result } = await instance.harness.prompt(text);

    return result;
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
 * of machine tasks. The CLI harness drives the real runner/ky-runner.ts.
 */
export async function runner(name: string, machine = "mac"): Promise<FakeRunner> {
  const socket = await connectRunner(name, machine);
  const commands: RunnerCommand[] = [];

  socket.addEventListener("message", (event) => {
    // The object also sends the Agents SDK's handshake on this socket; decoding skips it.
    const frame = decodeObjectFrame(String(event.data));

    if (frame !== undefined && "seq" in frame) commands.push(frame);
  });

  const send: FakeRunner["send"] = (report) => socket.send(JSON.stringify(report));
  send({ type: "hello", protocol: PROTOCOL, version: "test", active: [], facts: FACTS });

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
