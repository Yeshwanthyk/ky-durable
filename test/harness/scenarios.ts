import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TaskRow } from "../../src/protocol.ts";
import { decodeNewChat } from "../../src/tests/frames.ts";
import { type Client, connect, until } from "./client.ts";
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

/** Ask the main agent (or the chat on `from`), through the faux model, to start a task on `name`; resolves with its id. */
async function startTask(context: Context, name: string, prompt: string, from = context.main): Promise<string> {
  const known = new Set(context.main.frames.flatMap((frame) => (frame.type === "tasks" ? frame.tasks.map((row) => row.id) : [])));
  from.send({ type: "submit", input: `machine@${name} ${prompt}` });
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

/** Ask the main agent, through the faux model, for an automation; resolves with its id. */
async function createAutomation(context: Context, draft: Record<string, string>): Promise<string> {
  // The main chat's history is shared by every scenario: the answer is a new id, not one made before.
  const ids = () => [...JSON.stringify(context.main.frames).matchAll(/Created automation (\w+),/g)].map((match) => match[1]!);
  const before = new Set(ids());
  context.main.send({ type: "submit", input: `tool automation ${JSON.stringify({ action: "create", cron: "0 9 * * *", ...draft })}` });
  let id: string | undefined;

  await until("the automation to be created", () => {
    id = ids().find((each) => !before.has(each));

    return id !== undefined;
  });

  return id!;
}

/** Run the automation now and resolve with its run's task id, once the task list shows it. */
async function runAutomation(context: Context, id: string): Promise<string> {
  context.main.send({ type: "submit", input: `tool automation ${JSON.stringify({ action: "run", id })}` });
  let task: string | undefined;

  await until(`a run of automation ${id}`, () => {
    const latest = context.main.frames.findLast((frame) => frame.type === "tasks");
    task = latest?.type === "tasks" ? latest.tasks.find((row) => row.source === `automation:${id}`)?.id : undefined;

    return task !== undefined;
  });

  return task!;
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
    name: "skills",
    expect: "pass",
    about: "a skill the agent writes and the user edits is shared by every chat, with each version kept",
    async run(context) {
      const latest = () => {
        const frame = context.main.frames.findLast((each) => each.type === "skills");

        return frame?.type === "skills" ? frame.skills.find((skill) => skill.name === "harness-check") : undefined;
      };

      const skill = { action: "create", name: "harness-check", description: "How to check the harness", body: "Run step one." };
      context.main.send({ type: "submit", input: `tool skill_manage ${JSON.stringify(skill)}` });
      await until("the skill in the list", () => latest()?.body === "Run step one.");
      await context.main.command({
        type: "skill-change",
        change: { action: "patch", name: "harness-check", old: "step one", new: "step two" }
      });
      await until("the user's edit in the list", () => latest()?.body === "Run step two.");
      const { result } = await context.main.command({ type: "new-chat" });
      const session = decodeNewChat(result);

      if (session === undefined) throw new Error("new-chat answered without a session");
      const side = await connect(context.url, `?session=${session}`);
      context.cleanup.push(() => side.close());
      side.send({ type: "submit", input: 'tool skill_view {"name":"harness-check"}' });
      await until("the side chat to read the edited skill", () => side.heard("Run step two."));
      const history = JSON.stringify((await context.main.command({ type: "skill-history", name: "harness-check" })).result);
      check(history.includes('"actor":"user"') && history.includes('"actor":"agent"'), `both versions are kept, got ${history}`);
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
    name: "machine-facts",
    expect: "pass",
    about: "the runner tells ky its OS and git repos, with no credentials from a remote URL",
    async run(context) {
      const repos = path.join(context.dir, "facts-repos");
      mkdirSync(path.join(repos, "ky", ".git"), { recursive: true });
      writeFileSync(path.join(repos, "ky", ".git", "config"), '[remote "origin"]\n\turl = https://user:secret@github.com/me/ky.git\n');
      mkdirSync(path.join(repos, "notes"), { recursive: true });
      await context.machine("facts", { KY_REPOS: repos });

      const facts = () => {
        const latest = context.main.frames.findLast((frame) => frame.type === "tasks");

        return latest?.type === "tasks" ? latest.machines.find((each) => each.name === "facts")?.facts : undefined;
      };

      await until("the machine's facts", () => facts() !== undefined && facts() !== null);
      check(facts()?.os === process.platform, `the OS is ${process.platform}, got ${facts()?.os}`);
      const listed = JSON.stringify(facts()?.repos);
      check(listed === JSON.stringify([{ name: "ky", remote: "https://github.com/me/ky.git" }]), `one repo, no credentials, got ${listed}`);
    }
  },
  {
    name: "automation-run",
    expect: "pass",
    about: "a cloud automation run now is one task that ends done, and its result reaches the main chat",
    async run(context) {
      const id = await createAutomation(context, { title: "Harness digest", prompt: "digest for the harness" });
      const task = await runAutomation(context, id);
      check(new RegExp(`^a-${id}-\\d+$`).test(task), `the run's task is a-<id>-<slot>, got ${task}`);
      await status(context, task, "done");
      await until("the report", () => context.main.heard('[automation "Harness digest" result: tell the user] echo: digest for the harness'));
      await sleep(1_000);
      const runs = context.main.frames.findLast((frame) => frame.type === "tasks");
      const count = runs?.type === "tasks" ? runs.tasks.filter((row) => row.source === `automation:${id}`).length : 0;
      check(count === 1, `one run, got ${count}`);
    }
  },
  {
    name: "automation-machine",
    expect: "pass",
    about: "a machine automation runs once on the real runner and its report reaches the main chat",
    async run(context) {
      const { machine: mac } = await context.machine("auto");
      const id = await createAutomation(context, { title: "Harness backups", prompt: "check the backups", machine: "auto" });
      const task = await runAutomation(context, id);
      check(context.main.task(task)?.worker === "auto", `the run is on the machine, got ${context.main.task(task)?.worker}`);
      await status(context, task, "done");
      await until("the report", () => context.main.heard("fake claude did: check the backups"));
      check(context.main.heard(`task ${task}`), "the report names the task");
      await sleep(1_000);
      check(turns(mac, task).length === 1, `claude ran it once, got ${turns(mac, task).length}`);
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
    name: "side-chat-report",
    expect: "pass",
    about: "a task started from a side chat reports to that side chat, not the main chat",
    async run(context) {
      await context.machine("side");
      const { result } = await context.main.command({ type: "new-chat" });
      const session = decodeNewChat(result);

      if (session === undefined) throw new Error("new-chat answered without a session");
      const side = await connect(context.url, `?session=${session}`);
      context.cleanup.push(() => side.close());
      const task = await startTask(context, "side", "build it from the side", side);
      await status(context, task, "done");
      await until("the side chat's report", () => side.heard("fake claude did: build it from the side"));
      await sleep(1_000);
      check(!context.main.heard("fake claude did: build it from the side"), "the main chat did not get the report");
    }
  },
  {
    name: "steer-folded",
    expect: "pass",
    about: "a message Claude Code folds into the running turn ends with that turn's one result, not stuck working",
    async run(context) {
      await context.machine("fold");
      const task = await startTask(context, "fold", "[fold] [delay=3000] build the thing");
      await status(context, task, "working");
      sendTo(context, task, "and test it");
      await until("the task to end", () => terminal(context.main.task(task)), 20_000);
      check(context.main.task(task)?.status === "done", `the task ends done, not ${context.main.task(task)?.status}`);
      await until("the report", () => context.main.heard("fake claude did: [fold] [delay=3000] build the thing + and test it"));
      await sleep(1_500);
      check(context.main.task(task)?.status === "done", "the task does not reopen as working");
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
