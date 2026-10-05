import type { TaskRow } from "../../src/protocol.ts";
import { type Client, until } from "./client.ts";
import { type Proxy, startProxy } from "./proxy.ts";
import { machine, type Machine, type Runner } from "./runner.ts";
import { TOKEN } from "./stack.ts";

/**
 * The CLI harness's scenarios. Each drives the local stack the way the user
 * and a machine do: the browser's session socket on `me`, and a real
 * runner/ky-runner.ts process with the fake claude, connected through a
 * proxy the scenario can break.
 *
 * A `pass` scenario checks a feature that works today; the `trap-*` ones
 * replay the six Quint counterexamples (explainers/ky-architecture/
 * quint/README.md) and check the fixed protocol's property. An `xfail`
 * scenario checks something known broken: it is expected to fail with a
 * `Violation`. Any other error, such as a timeout, is a FAIL either way, so a
 * broken harness never passes as XFAIL.
 */

/** The property under test does not hold. */
export class Violation extends Error {}

export type Context = {
  url: string;
  /** A directory for this scenario's machines and logs. */
  dir: string;
  main: Client;
  /** A machine and its runner, connected through a fresh proxy, online once this resolves. */
  machine: (name: string, env?: Record<string, string>) => Promise<{ machine: Machine; proxy: Proxy }>;
  /** The scenario's runner, stopped when it ends. */
  runner: Runner | undefined;
  cleanup: Array<() => Promise<void> | void>;
};

export type Scenario = {
  name: string;
  expect: "pass" | "xfail";
  about: string;
  run: (context: Context) => Promise<void>;
};

function check(holds: boolean, property: string): void {
  if (!holds) throw new Violation(property);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TERMINAL = new Set(["done", "failed", "stopped"]);

function terminal(row: TaskRow | undefined): boolean {
  return row !== undefined && TERMINAL.has(row.status);
}

/** Ask the main agent, through the faux model, to start a task on `name`; resolves with its id. */
async function startTask(context: Context, name: string, prompt: string): Promise<string> {
  const known = new Set(context.main.frames.flatMap((frame) => (frame.type === "tasks" ? frame.tasks.map((row) => row.id) : [])));
  context.main.send({ type: "submit", input: `machine@${name} ${prompt}` });
  let id: string | undefined;

  await until(`a task on ${name}`, () => {
    const latest = context.main.frames.findLast((frame) => frame.type === "tasks");
    id = latest?.type === "tasks" ? latest.tasks.find((row) => row.worker === name && !known.has(row.id))?.id : undefined;

    return id !== undefined;
  });

  return id!;
}

/** Whether the task list shows the machine online. */
export function online(context: Context, name: string): boolean {
  const latest = context.main.frames.findLast((frame) => frame.type === "tasks");

  return latest?.type === "tasks" && latest.machines.some((each) => each.name === name && each.online);
}

function sendTo(context: Context, task: string, message: string): void {
  context.main.send({ type: "submit", input: `tool machine ${JSON.stringify({ action: "send", task, message })}` });
}

async function status(context: Context, task: string, wanted: string, timeoutMs?: number): Promise<void> {
  await until(`task ${task} to be ${wanted}`, () => context.main.task(task)?.status === wanted, timeoutMs);
}

function turns(machineOf: Machine, task: string): string[] {
  return machineOf.claude().flatMap((event) => (event.event === "turn" && event.task === task ? [event.prompt ?? ""] : []));
}

/** A terminal status followed by another terminal or reopened status. */
function flipped(history: readonly string[]): boolean {
  const statuses: string[] = [];

  for (const entry of history) {
    const status = entry.split(":")[0]!;

    if (statuses.at(-1) !== status) statuses.push(status);
  }

  const first = statuses.findIndex((each) => TERMINAL.has(each));

  return first !== -1 && first < statuses.length - 1;
}

export const SCENARIOS: Scenario[] = [
  {
    name: "chat",
    expect: "pass",
    about: "a chat turn streams the model's answer to the browser's socket",
    async run(context) {
      context.main.send({ type: "submit", input: "hello from the harness" });
      await until("the answer", () => context.main.heard("echo: hello from the harness"));
      const hello = context.main.frames.find((frame) => frame.type === "hello");
      check(hello?.type === "hello" && hello.tools.some((tool) => tool.name === "machine"), "hello lists the machine tool");
    }
  },
  {
    name: "machine-run",
    expect: "pass",
    about: "a machine task runs on the real runner and its result reaches the main agent",
    async run(context) {
      const { machine: mac } = await context.machine("run");
      const task = await startTask(context, "run", "build the thing");
      await status(context, task, "done");
      check(turns(mac, task).length === 1, "the task ran once");
      await until("the report", () => context.main.heard("fake claude did: build the thing"));
      check(context.main.heard(`task ${task}`), "the report names the task");
    }
  },
  {
    name: "steps",
    expect: "pass",
    about: "each tool claude uses shows as a step on the task, and the result carries its turns and cost",
    async run(context) {
      await context.machine("steps");
      const task = await startTask(context, "steps", "[tools=Bash:pnpm test,Edit:src/tasks.ts] fix the tests");
      await status(context, task, "done");
      const row = context.main.task(task)!;
      const steps = row.steps.map((step) => step.text).join(" | ");
      check(steps === "Running pnpm test | Editing tasks.ts", `the steps are the tools used, got ${steps}`);
      check(`${row.turns} ${row.cost_usd}` === "1 0.01", `the task spent one turn and a cent, got ${row.turns} and ${row.cost_usd}`);
      check(Number(row.finished_at) >= Number(row.started_at), "the task has a start and a finish");
    }
  },
  {
    name: "follow-up",
    expect: "pass",
    about: "a message to a finished task resumes its Claude session with a new turn",
    async run(context) {
      const { machine: mac } = await context.machine("followup");
      const task = await startTask(context, "followup", "write the draft");
      await status(context, task, "done");
      const first = mac.claude().find((event) => event.event === "start" && event.task === task);
      sendTo(context, task, "now polish it");
      await until("the follow-up turn", () => turns(mac, task).includes("now polish it"));
      await until("the follow-up to finish", () => context.main.history(task).filter((entry) => entry.startsWith("done")).length >= 2);
      const resumed = mac.claude().findLast((event) => event.event === "start" && event.task === task);
      check(resumed !== undefined && resumed.resume === first?.session, "the follow-up resumed the first session");
    }
  },
  {
    name: "stop",
    expect: "pass",
    about: "stopping a working task interrupts its claude and marks it stopped",
    async run(context) {
      const { machine: mac } = await context.machine("stop");
      const task = await startTask(context, "stop", "[delay=30000] a long job");
      await status(context, task, "working");
      await context.main.command({ type: "stop-task", task });
      await status(context, task, "stopped");
      check(mac.claude().some((event) => event.event === "sigint" && event.task === task), "claude got SIGINT");
    }
  },
  {
    name: "screenshot",
    expect: "pass",
    about: "a task shares a screenshot through ky-attach and /api/files serves it",
    async run(context) {
      await context.machine("shots");
      const task = await startTask(context, "shots", "[attach] screenshot the page");
      await status(context, task, "done");
      const latest = context.main.frames.findLast((frame) => frame.type === "tasks");
      const file = latest?.type === "tasks" ? latest.files.find((row) => row.task === task) : undefined;
      check(file !== undefined && file.caption === "a fake screenshot", "the task lists the screenshot");
      const response = await fetch(`${context.url}/api/files/${file!.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      check(response.status === 200 && response.headers.get("Content-Type") === "image/png", "the file is served");
    }
  },
  {
    name: "reconnect",
    expect: "pass",
    about: "a runner that loses its socket mid-task reconnects and still delivers the result",
    async run(context) {
      const { machine: mac, proxy } = await context.machine("blip");
      const task = await startTask(context, "blip", "[delay=4000] survive a blip");
      await status(context, task, "working");
      proxy.cut();
      await until("the runner to reconnect", () => proxy.connections() >= 2);
      await status(context, task, "done", 20_000);
      check(!flipped(context.main.history(task)) && !context.main.history(task).some((entry) => entry.startsWith("failed")), "no false failure");
      check(turns(mac, task).length === 1, "the task ran once");
    }
  },

  {
    name: "reconnect-outage",
    expect: "pass",
    about: "a runner whose retry fails (503, or nothing listening) keeps retrying and reconnects",
    async run(context) {
      const { proxy } = await context.machine("outage");
      // Node's WebSocket fires only `error`, not `close`, when a handshake
      // fails; the runner must retry on that too.
      proxy.cut("refuse");
      await sleep(1_500);
      proxy.open();

      try {
        await until("the runner to reconnect", () => proxy.connections() >= 2, 10_000);
      } catch {
        throw new Violation("the runner never reconnected after one failed retry");
      }
    }
  },

  // The six Quint traps, replayed on the fixed protocol.
  {
    name: "trap-stopRace",
    expect: "pass",
    about: "stop while the run's ack is in flight: the run is stopped, with one report and no 'Stopped before it started'",
    async run(context) {
      const { machine: mac, proxy } = await context.machine("stoprace");
      proxy.hold();
      const task = await startTask(context, "stoprace", "[delay=30000] racing the stop");
      await until("the runner to start it", () => turns(mac, task).length > 0);
      // The runner's ack is still held: ky must not take the run for unsent.
      await context.main.command({ type: "stop-task", task });
      await until("claude to get SIGINT", () => mac.claude().some((event) => event.event === "sigint" && event.task === task));
      proxy.release();
      await until("ky to answer the stop", () => terminal(context.main.task(task)));
      await sleep(2_000);
      const saidNotStarted = context.main.history(task).some((entry) => entry.includes("before it started"));
      check(!(saidNotStarted && turns(mac, task).length > 0), "NoRunAfterStoppedReport: a task reported 'Stopped before it started' never runs");
      check(!flipped(context.main.history(task)), "NoTerminalFlip: a stopped task is not reopened or finished again");
      check(context.main.task(task)?.status === "stopped", "the task ends stopped");
    }
  },
  {
    name: "trap-helloBeforeOutbox",
    expect: "pass",
    about: "a result finished offline is reported once, as done, with no false 'Interrupted' from the reconnect hello",
    async run(context) {
      const { machine: mac, proxy } = await context.machine("outbox");
      const task = await startTask(context, "outbox", "[delay=1500] finish while offline");
      await status(context, task, "working");
      proxy.cut("stall");
      await until("claude to finish offline", () => mac.claude().some((event) => event.event === "exit" && event.task === task), 20_000);
      proxy.open();
      await until("the runner to reconnect", () => proxy.connections() >= 2, 20_000);
      await until("the task to end", () => terminal(context.main.task(task)));
      await sleep(1_500);
      check(!context.main.history(task).some((entry) => entry.includes("Interrupted")), "NoFalseInterrupt: no 'Interrupted' while the result is on its way");
      check(!flipped(context.main.history(task)) && context.main.task(task)?.status === "done", "one terminal report, done");
    }
  },
  {
    name: "trap-dupExec",
    expect: "pass",
    about: "the ack is lost and the runner restarts: the redelivered run does not execute again",
    async run(context) {
      const { machine: mac, proxy } = await context.machine("dupexec");
      proxy.dropWhen((report) => report.type === "ack");
      const task = await startTask(context, "dupexec", "run me once");
      await until("the runner to start it", () => turns(mac, task).length > 0);
      await context.runner!.kill();
      proxy.dropWhen(() => false);
      context.runner = mac.launch(proxy.url);
      await until("the restarted runner to connect", () => proxy.connections() >= 2);
      await sleep(2_000);
      check(turns(mac, task).length === 1, `NoDuplicateExecution: ran ${turns(mac, task).length} times`);
    }
  },
  {
    name: "trap-steerIntoStop",
    expect: "pass",
    about: "a message sent right after stop is not lost to the dying claude: it runs after the stop",
    async run(context) {
      const { machine: mac } = await context.machine("steerstop", { FAKE_CLAUDE_SIGINT_MS: "2000" });
      const task = await startTask(context, "steerstop", "[delay=30000] a long job");
      await status(context, task, "working");
      await context.main.command({ type: "stop-task", task });
      await until("claude to get SIGINT", () => mac.claude().some((event) => event.event === "sigint" && event.task === task));
      sendTo(context, task, "carry on after the stop");
      await until("the stop to finish", () => terminal(context.main.task(task)), 20_000);
      await sleep(3_000);
      check(turns(mac, task).includes("carry on after the stop"), "NoSteerIntoStoppedRun: the message after the stop runs");
    }
  },
  {
    name: "trap-stuckQueued",
    expect: "pass",
    about: "the result is lost on a dropping socket before any session report: the task still ends",
    async run(context) {
      const { machine: mac, proxy } = await context.machine("stuck");
      proxy.dropWhen((report) => report.type === "session" || report.type === "step" || report.type === "result");
      const task = await startTask(context, "stuck", "finish unheard");
      await until("claude to finish", () => mac.claude().some((event) => event.event === "exit" && event.task === task));
      proxy.cut();
      proxy.dropWhen(() => false);
      await until("the runner to reconnect", () => proxy.connections() >= 2);
      await sleep(2_000);
      check(terminal(context.main.task(task)), `QuiescentRecoverable: the task is ${context.main.task(task)?.status ?? "missing"}, not ended`);
    }
  },
  {
    name: "trap-reorder",
    expect: "pass",
    about: "a task started offline gets a follow-up before the hello is handled: the turns run in order",
    async run(context) {
      const offline = machine("reorder", context.dir);
      const task = await startTask(context, "reorder", "[delay=300] the first message");
      await status(context, task, "queued");
      const proxy = await startProxy(context.url);
      context.cleanup.push(() => proxy.close());
      proxy.hold();
      context.runner = offline.launch(proxy.url);
      await until("the runner to connect", () => online(context, "reorder"));
      sendTo(context, task, "the second message");
      await until("a turn to start", () => turns(offline, task).length > 0);
      proxy.release();
      await until("both turns", () => turns(offline, task).length >= 2);
      check(turns(offline, task)[0] === "[delay=300] the first message", `NoOutOfOrderExecution: ran ${JSON.stringify(turns(offline, task))}`);
    }
  }
];
