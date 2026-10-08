import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocket as Socket } from "ws";
import type { TaskRow } from "../../src/protocol.ts";
import { decodeObjectFrame, type ObjectFrame, OUTDATED, PROTOCOL, RUNNER_PATH } from "../../src/runner-protocol.ts";
import { decodeNewChat } from "../../src/tests/frames.ts";
import { type Client, connect, until } from "./client.ts";
import { type Proxy, startProxy } from "./proxy.ts";
import { type FakeEvent, machine, type Machine, type Runner } from "./runner.ts";
import { TOKEN } from "./stack.ts";

/**
 * The CLI harness's scenarios. Each drives the local stack the way the user
 * and a machine do: the browser's session socket on `me`, and a real
 * runner/ky-runner.ts process with the fake claude and codex, connected
 * through a proxy the scenario can break.
 *
 * A `pass` scenario checks a feature that works today. The six Quint
 * counterexamples are replayed in src/tests/runner-protocol.test.ts. An `xfail`
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
function startTask(context: Context, name: string, prompt: string, from = context.main): Promise<string> {
  return started(context, name, `machine@${name} ${prompt}`, from);
}

/** Ask the main agent for a task on `name` that runs as Codex; resolves with its id. */
function startCodex(context: Context, name: string, prompt: string): Promise<string> {
  return started(context, name, `tool machine ${JSON.stringify({ action: "run", machine: name, agent: "codex", prompt })}`, context.main);
}

/** Submit `input` on `from`, and resolve with the id of the new task on `name` it starts. */
async function started(context: Context, name: string, input: string, from: Client): Promise<string> {
  const known = new Set(context.main.frames.flatMap((frame) => (frame.type === "tasks" ? frame.tasks.map((row) => row.id) : [])));
  from.send({ type: "submit", input });
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

/** The prompts a fake CLI took in for a task, in order: claude's by default. */
function turns(machineOf: Machine, task: string, events: FakeEvent[] = machineOf.claude()): string[] {
  return events.flatMap((event) => (event.event === "turn" && event.task === task ? [event.prompt ?? ""] : []));
}

/** The fake codex's `index`th start for a task; it fails the check if there is none. */
function codexStart(machineOf: Machine, task: string, index: number): FakeEvent {
  const start = machineOf.codex().filter((event) => event.event === "start" && event.task === task)[index];

  if (!start) throw new Error(`codex started ${task} fewer than ${index + 1} times`);

  return start;
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

/** Ask a test route on the stack, which answers 204 once it is done. */
async function testRoute(context: Context, route: string): Promise<void> {
  const response = await fetch(`${context.url}${route}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });

  if (response.status !== 204) throw new Error(`${route} answered ${response.status}`);
}

/** The newest task list's rows for a worker. */
function rowsOf(context: Context, worker: string): TaskRow[] {
  const latest = context.main.frames.findLast((frame) => frame.type === "tasks");

  return latest?.type === "tasks" ? latest.tasks.filter((row) => row.worker === worker) : [];
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
    name: "skill-review",
    expect: "pass",
    about: "a turn with enough tool calls is reviewed for skills in the background, shown in Activity",
    async run(context) {
      const before = new Set(rowsOf(context, "skills").map((row) => row.id));
      await testRoute(context, "/test/review-after?n=1");
      context.cleanup.push(() => testRoute(context, "/test/review-after?n=5"));
      context.main.send({ type: "submit", input: 'tool skill_view {"name":"harness-check"}' });
      let review: TaskRow | undefined;

      await until("a finished skill review", () => {
        review = rowsOf(context, "skills").find((row) => !before.has(row.id) && row.status === "done");

        return review !== undefined;
      });

      check(review!.title === "Skill review", `the row is titled Skill review, got ${review!.title}`);
      check(review!.session !== null, "the row opens the review's conversation");
    }
  },
  {
    name: "dreaming",
    expect: "pass",
    about: "a dream reads what happened since the last one, shows one Activity row, then has nothing to tend",
    async run(context) {
      const before = new Set(rowsOf(context, "dreaming").map((row) => row.id));
      const note = `the harness dreamed at ${Date.now()}`;
      context.main.send({ type: "submit", input: `tool memory_note ${JSON.stringify({ text: note })}` });
      await until("the memory to be saved", () => context.main.heard("Saved as #"));
      await testRoute(context, "/test/dream");
      let dream: TaskRow | undefined;

      await until("a finished dream", () => {
        dream = rowsOf(context, "dreaming").find((row) => !before.has(row.id) && row.status !== "working");

        return dream !== undefined;
      });

      const rows = rowsOf(context, "dreaming");
      check(dream!.status === "done", `the dream finished, got ${dream!.status}`);
      check(dream!.title === "Dreaming", `the row is titled Dreaming, got ${dream!.title}`);
      check(dream!.summary.startsWith("echo: [dream]"), `the dream answered, got ${dream!.summary}`);
      await testRoute(context, "/test/dream");
      check(rowsOf(context, "dreaming").length === rows.length, "a dream with nothing new adds no row");
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
    about: "the runner tells ky its OS, git repos with no credentials from a remote URL, and which agents it runs",
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
      const { agents, ports, kind } = facts()!;
      const said = JSON.stringify({ agents, ports, kind });
      const agentsHere = { claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true } };
      check(said === JSON.stringify({ agents: agentsHere, ports: [], kind: "computer" }), `a computer with claude and codex signed in and no ports, got ${said}`);
    }
  },
  {
    name: "outdated-runner",
    expect: "pass",
    about: "a runner of another protocol is told goodbye with the protocol ky speaks, and its socket closes as outdated",
    async run(context) {
      const socket = new Socket(`${context.url.replace(/^http/, "ws")}${RUNNER_PATH}old`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      const frames: ObjectFrame[] = [];
      let closedBy: number | undefined;
      context.cleanup.push(() => socket.close());
      socket.on("message", (data) => {
        const frame = decodeObjectFrame(String(data));

        if (frame) frames.push(frame);
      });
      socket.on("close", (code) => {
        closedBy = code;
      });
      socket.on("open", () => socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL - 1, active: [] })));

      await until("the socket to close", () => closedBy !== undefined);
      check(closedBy === OUTDATED, `closed with ${OUTDATED}, got ${closedBy}`);
      const goodbye = frames.find((frame) => frame.type === "goodbye");
      check(goodbye?.type === "goodbye" && goodbye.expected === PROTOCOL, `a goodbye expecting ${PROTOCOL}, got ${JSON.stringify(frames)}`);
    }
  },
  {
    name: "outdated-runner-exits",
    expect: "pass",
    about: "a runner told goodbye by a ky of another protocol exits 1 and says to update it",
    async run(context) {
      const proxy = await startProxy(context.url);
      context.cleanup.push(() => proxy.close());
      proxy.speak(PROTOCOL + 1);
      const runner = machine("newer", context.dir).launch(proxy.url);
      context.runner = runner;

      await until("the runner to exit", () => runner.exitCode() !== null);
      check(runner.exitCode() === 1, `exited 1, got ${runner.exitCode()}`);
      check(runner.output().includes(`ky said goodbye: ky speaks runner protocol ${PROTOCOL + 1}.`), "logged the goodbye");
      check(runner.output().includes("Update it."), `logged to update it, got ${runner.output()}`);
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
    name: "codex-run",
    expect: "pass",
    about: "a task asked to run as Codex runs codex exec in its own CODEX_HOME, signed in with the machine's login, and reports back",
    async run(context) {
      const { machine: mac } = await context.machine("codex");
      const task = await startCodex(context, "codex", "[tools=Bash:pnpm test,Edit:src/tasks.ts] fix the tests");
      await status(context, task, "done");
      const row = context.main.task(task)!;
      check(row.agent === "codex", `the task records its agent, got ${row.agent}`);
      check(turns(mac, task).length === 0 && turns(mac, task, mac.codex()).length === 1, "codex ran it once, and claude never did");
      const steps = row.steps.map((step) => step.text).join(" | ");
      check(steps.startsWith("Running pnpm test | Editing tasks.ts"), `codex's items show as steps, got ${steps}`);
      const start = codexStart(mac, task, 0);
      check(start.home === path.join(mac.dir, "state", "codex", task), `the task has its own CODEX_HOME, got ${start.home}`);
      check(start.auth === path.join(mac.dir, "home", ".codex", "auth.json"), `its auth.json links to the machine's, got ${start.auth}`);
      check(start.instructions === 1, "codex was told it runs a task for ky");
      await until("the report", () => context.main.heard("fake codex did: [tools=Bash:pnpm test,Edit:src/tasks.ts] fix the tests"));
    }
  },
  {
    name: "codex-follow-up",
    expect: "pass",
    about: "a message to a finished Codex task resumes its thread in its own CODEX_HOME, as Codex",
    async run(context) {
      const { machine: mac } = await context.machine("codexfollow");
      const task = await startCodex(context, "codexfollow", "write the draft");
      await status(context, task, "done");
      sendTo(context, task, "now polish it");
      await until("the follow-up turn", () => turns(mac, task, mac.codex()).includes("now polish it"));
      await until("the follow-up's report", () => context.main.heard("fake codex did: now polish it"));
      const [first, resumed] = [codexStart(mac, task, 0), codexStart(mac, task, 1)];
      check(resumed.resume === first.session, "the follow-up resumed the first thread");
      check(resumed.home === first.home, "in the same CODEX_HOME");
      check(turns(mac, task).length === 0, "claude never ran it");
    }
  },
  {
    name: "codex-queued",
    expect: "pass",
    about: "a message to a working Codex task, which takes none mid-turn, runs once that turn ends, resuming its thread",
    async run(context) {
      const { machine: mac } = await context.machine("codexqueue");
      const task = await startCodex(context, "codexqueue", "[delay=3000] build the thing");
      await status(context, task, "working");
      sendTo(context, task, "and test it");
      await until("both reports", () => context.main.heard("fake codex did: [delay=3000] build the thing") && context.main.heard("fake codex did: and test it"), 20_000);
      const prompts = turns(mac, task, mac.codex()).join(" | ");
      check(prompts === "[delay=3000] build the thing | and test it", `each message ran as its own turn, in order, got ${prompts}`);
      check(codexStart(mac, task, 1).resume === codexStart(mac, task, 0).session, "the second turn resumed the first's thread");
    }
  },
  {
    name: "codex-stop",
    expect: "pass",
    about: "stopping a working Codex task interrupts its codex and marks it stopped",
    async run(context) {
      const { machine: mac } = await context.machine("codexstop");
      const task = await startCodex(context, "codexstop", "[delay=30000] a long job");
      await status(context, task, "working");
      await context.main.command({ type: "stop-task", task });
      await status(context, task, "stopped");
      check(mac.codex().some((event) => event.event === "sigint" && event.task === task), "codex got SIGINT");
    }
  },
  {
    name: "codex-move",
    expect: "pass",
    about: "a Codex task queued for an offline machine moves to another, and runs there as Codex",
    async run(context) {
      const { machine: away } = await context.machine("codexaway");
      await context.runner?.stop();
      await until("codexaway to go offline", () => !online(context, "codexaway"));
      const task = await startCodex(context, "codexaway", "build it elsewhere");
      const { machine: there } = await context.machine("codexthere");
      context.main.send({ type: "submit", input: `tool machine ${JSON.stringify({ action: "move", task, machine: "codexthere" })}` });
      await status(context, task, "done");
      check(context.main.task(task)?.worker === "codexthere", `the task moved, got ${context.main.task(task)?.worker}`);
      check(turns(there, task, there.codex()).length === 1, "codex ran it on the machine it moved to");
      check(turns(there, task).length === 0 && away.codex().length === 0, "as Codex, and only there");
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
  }
];
