import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { WebSocket as Socket } from "ws";
import type { FileRow, TaskRow } from "../../src/protocol.ts";
import { decodeObjectFrame, type ObjectFrame, OUTDATED, PROTOCOL, RUNNER_PATH } from "../../src/machines/contract.ts";
import { signedIn } from "../../src/tests/fake-access.ts";
import { decodeNewChat } from "../../src/tests/frames.ts";
import { type Client, connect, until } from "./client.ts";
import { type Proxy, startProxy } from "./proxy.ts";
import { FAKE_CLAUDE, FAKE_CODEX, type FakeEvent, KY_COMMAND, machine, type Machine, pairingCode, type Runner } from "./runner.ts";
import { type ContainerHost, serveContainer } from "../fakes/container.ts";
import { type GitServer, serveGit } from "../fakes/git.ts";
import { serveVibeProxy, type VibeProxyServer } from "./vibeproxy.ts";
import { VIBEPROXY_TEST_PORT } from "../fakes/vibeproxy.ts";
import { PART_BYTES } from "../../src/uploads.ts";

/**
 * The CLI harness's scenarios. Each drives the local stack the way the user
 * and a machine do: the browser's session socket on `me`, and a real
 * `ky runner run` process with the fake claude and codex, connected
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

/** `GET /test/cloud-snapshot`'s answer. */
const Snapshotted = Type.Object({ turnsEnded: Type.Number(), snapshotted: Type.Number() });

export type Context = {
  url: string;
  /** A directory for this scenario's machines and logs. */
  dir: string;
  main: Client;
  /** A machine paired with a fresh code, through `through` or a proxy of its own; its runner not started. */
  paired: (name: string, through?: Proxy) => Promise<Machine>;
  /** A machine and its runner, paired and connected through a fresh proxy, online once this resolves. */
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

/** Ask the main agent (or the chat on `from`), through the fake AI binding, to start a task on `name`; resolves with its id. */
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

/** The file a task shared, as the task list shows it. */
function sharedBy(context: Context, task: string): FileRow | undefined {
  const latest = context.main.frames.findLast((frame) => frame.type === "tasks");

  return latest?.type === "tasks" ? latest.files.find((row) => row.task === task) : undefined;
}

/** Ask the main agent, through the fake AI binding, for an automation; resolves with its id. */
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
  const response = await fetch(`${context.url}${route}`, { method: "POST", headers: await signedIn() });

  if (response.status !== 204) throw new Error(`${route} answered ${response.status}`);
}

/** Whether the task's last claude start resumed its first start's session, in another process. */
function resumedInNewProcess(machineOf: Machine, task: string): boolean {
  const starts = machineOf.claude().filter((event) => event.event === "start" && event.task === task);
  const [first, last] = [starts[0], starts.at(-1)];

  return first !== undefined && last !== undefined && last.resume === first.session && last.pid !== first.pid;
}

/** Send the task `message` as its next turn, and wait for the turn to run and the task to be done again. */
async function followUp(context: Context, logs: Machine, task: string, message: string): Promise<void> {
  sendTo(context, task, message);
  await until("the follow-up turn", () => turns(logs, task).includes(message), 60_000);
  await until("the follow-up to finish", () => context.main.history(task).filter((entry) => entry.startsWith("done")).length >= 2, 30_000);
}

/** Wait until R2 has the cloud machine's disk as of every turn ended so far, as a snapshot after a turn puts it. */
async function snapshotted(context: Context, timeoutMs = 30_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; ; await sleep(250)) {
    const response = await fetch(`${context.url}/test/cloud-snapshot`, { headers: await signedIn() });
    const { turnsEnded, snapshotted: saved } = Value.Parse(Snapshotted, await response.json());

    if (turnsEnded > 0 && saved >= turnsEnded) return;

    if (Date.now() > deadline) throw new Violation(`R2 never caught up with the cloud machine: ${saved} of ${turnsEnded} turns ended`);
  }
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

/** Delete a machine as the user does in Settings; resolves with the HTTP status. */
async function removeMachine(context: Context, name: string): Promise<number> {
  return (await fetch(`${context.url}/api/runners/${name}`, { method: "DELETE", headers: await signedIn() })).status;
}

/** A machine with neither the claude nor the codex CLI signed in. */
const SIGNED_OUT = { FAKE_CLAUDE_SIGNED_OUT: "1", FAKE_CODEX_SIGNED_OUT: "1" };

/** The fake CLIs' fingerprint of a token, as they log it in place of the token. */
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 12);

/** What chatgpt-login answers once OpenAI has given a code. */
const LoginStarted = Type.Object({ loginId: Type.String() });

/**
 * Set up both subscriptions in Settings, as the user does: paste a Claude
 * token, then sign in to ChatGPT with a device code, which the fake OpenAI
 * approves on the Vault's second poll. Both are removed when the scenario
 * ends. Resolves with the Claude token.
 */
async function subscribe(context: Context): Promise<string> {
  const claude = `sk-ant-oat01-harness-${crypto.randomUUID()}`;
  context.cleanup.push(() => {
    context.main.send({ type: "remove-subscription", id: crypto.randomUUID(), kind: "claude" });
    context.main.send({ type: "remove-subscription", id: crypto.randomUUID(), kind: "chatgpt" });
  });
  const saved = JSON.stringify((await context.main.command({ type: "set-claude", token: claude })).result);
  check(saved === "{}", `the Claude token was kept, got ${saved}`);
  const code = (await context.main.command({ type: "chatgpt-login" })).result;
  check(Value.Check(LoginStarted, code), `ChatGPT's sign-in started, got ${JSON.stringify(code)}`);
  // SAFETY: checked just above.
  const login = (code as Static<typeof LoginStarted>).loginId;
  const deadline = Date.now() + 15_000;
  let state = "";

  while (state !== '"done"' && Date.now() < deadline) {
    await sleep(500);
    state = JSON.stringify((await context.main.command({ type: "chatgpt-poll", login })).result);
  }

  check(state === '"done"', `the ChatGPT sign-in finished, got ${state}`);
  await until("both subscriptions in Settings", () => {
    const latest = context.main.frames.findLast((frame) => frame.type === "subscriptions");

    return latest?.type === "subscriptions" && latest.subscriptions.filter((each) => each.kind !== "github").every((each) => each.connected);
  });

  return claude;
}

/** The fake VibeProxy on its port, closed when the scenario ends, and a machine `name` whose runner shares that port. */
async function sharingVibeProxy(context: Context, name: string): Promise<VibeProxyServer> {
  const server = await serveVibeProxy();
  context.cleanup.push(() => server.close());
  await context.machine(name, { KY_RUNNER_PORTS: String(VIBEPROXY_TEST_PORT) });

  return server;
}

/** VibeProxy as the newest Settings shows it. */
function vibeProxyShown(context: Context): { name: string; connected: boolean } | undefined {
  const latest = context.main.frames.findLast((frame) => frame.type === "settings");

  return latest?.type === "settings" ? latest.settings.providers.find((provider) => provider.id === "vibeproxy") : undefined;
}

/** Send a request over the pipe from inside `me`, through the stack's test route: its status and body, or why it failed. */
async function overPipe(context: Context, query: Record<string, string>): Promise<{ status?: number; body?: string; failed?: string }> {
  const response = await fetch(`${context.url}/test/pipe?${new URLSearchParams(query)}`, { method: "POST", headers: await signedIn() });

  if (!response.ok) throw new Error(`/test/pipe answered ${response.status}`);

  // SAFETY: /test/pipe answers with overPipe's result.
  return (await response.json()) as { status?: number; body?: string; failed?: string };
}

/** The fine-grained GitHub token the cloud scenarios set up in Settings, which the fake github.com takes. */
const GITHUB_TOKEN = "github_pat_harness";

/** The cloud machine's name: one per deploy. */
const CLOUD = "cloud";

/** A shell script's lines that clone me/app and commit a file on a new `branch`, then `push` it. */
function kyBranch(branch: string, push: string): string[] {
  return ["git clone -q https://github.com/me/app.git app", "cd app", `git checkout -qb ${branch}`, "echo cloud > cloud.txt", "git add cloud.txt", "git commit -qm cloud", push];
}

/** Run a shell script as a task on the cloud machine, until its report has `last`, the script's last line's echo. */
async function cloudScript(context: Context, lines: string[], last: string): Promise<void> {
  const task = await startTask(context, CLOUD, `[sh] ${lines.join("; ")}`);
  await status(context, task, "done", 60_000);
  // The prompt holds `last`'s echo too, and the task can read done before its report reaches the
  // chat: wait for the report's own header, then its last line, before checking the earlier ones.
  await until("the report", () => context.main.heard(`[machine ${CLOUD}, task ${task} "`) && context.main.heard(last));
}

/** The large work tree's files and sizes: past one R2 upload part, of bytes gzip can't shrink. */
const LARGE_TREE: ReadonlyArray<readonly [string, number]> = [
  ["tree/big.bin", PART_BYTES + 3_000_000],
  ["tree/a/one.bin", 300_000],
  ["tree/a/two.txt", 1_000]
];

/** A file's bytes: each 32 the hash of its name and offset. In the shell script below and here, the same. */
const LARGE_TREE_WRITE = `const c=require("crypto"),f=require("fs");f.mkdirSync("tree/a",{recursive:true});for(const [n,s] of ${JSON.stringify(LARGE_TREE)}){const b=Buffer.alloc(s);for(let i=0;i<s;i+=32)c.createHash("sha256").update(n+i).digest().copy(b,i);f.writeFileSync(n,b)}`;

/** A node script that prints `label` and the hash of the large tree's every name and content. */
const largeTreeHashScript = (label: string) =>
  `const c=require("crypto"),f=require("fs"),h=c.createHash("sha256");for(const [n] of ${JSON.stringify(LARGE_TREE)})h.update(n).update(f.readFileSync(n));console.log("${label} "+h.digest("hex"))`;

/** What `largeTreeHashScript` prints of the tree `LARGE_TREE_WRITE` writes. */
function largeTreeHash(): string {
  const tree = createHash("sha256");

  for (const [name, size] of LARGE_TREE) {
    const content = Buffer.alloc(size);

    for (let at = 0; at < size; at += 32) content.set(createHash("sha256").update(name + at).digest().subarray(0, Math.min(32, size - at)), at);
    tree.update(name).update(content);
  }

  return tree.digest("hex");
}

type Cloud = { logs: Machine; host: ContainerHost; proxy: Proxy; git: GitServer };

/**
 * The cloud machine for one scenario: its container on a fake host whose runner dials ky through a
 * proxy the scenario can break, git on a fake github.com, and GitHub set up in Settings with me/app.
 * It sleeps once idle `idleMs`, if given. The container starts when a task is sent to it; when the
 * scenario ends it is reset: stopped, and its save forgotten.
 */
async function cloudMachine(context: Context, idleMs?: number): Promise<Cloud> {
  const logs = machine(CLOUD, context.dir);
  const proxy = await startProxy(context.url);
  const git = await serveGit(GITHUB_TOKEN);

  const host = await serveContainer({
    ky: KY_COMMAND,
    kyUrl: proxy.url,
    github: `${context.url}/github.internal/api/git/`,
    env: {
      KY_CLAUDE: FAKE_CLAUDE,
      FAKE_CLAUDE_LOG: path.join(logs.dir, "claude.jsonl"),
      FAKE_CLAUDE_SESSIONS: "1",
      KY_CODEX: FAKE_CODEX,
      FAKE_CODEX_LOG: path.join(logs.dir, "codex.jsonl")
    },
    logs: logs.dir
  });

  context.cleanup.push(
    () => proxy.close(),
    () => git.close(),
    () => host.close(),
    () => testRoute(context, "/test/cloud-reset"),
    // Awaited: sent and left, its removal can land after the next scenario's set-github and take its token.
    async () => void (await context.main.command({ type: "remove-subscription", kind: "github" }))
  );
  const query = new URLSearchParams({ url: host.url, github: git.url, ...(idleMs !== undefined && { idle: String(idleMs) }) });

  await testRoute(context, `/test/cloud-host?${query}`);
  const saved = JSON.stringify((await context.main.command({ type: "set-github", token: GITHUB_TOKEN, repos: ["me/app"] })).result);
  check(saved === "{}", `the GitHub token was kept, got ${saved}`);

  return { logs, host, proxy, git };
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
      const seen = context.main.frames.length;
      context.main.send({ type: "submit", input: `tool memory_note ${JSON.stringify({ text: note })}` });
      await until("the memory to be saved", () => context.main.heard("Saved as #"));
      // The turn's reply is saved after the tool's result: dreaming before it ends, the next dream finds the reply new.
      await until("the turn to end", () =>
        context.main.frames.slice(seen).some((frame) => frame.type === "events" && frame.events.some((event) => event.type === "run_end"))
      );
      await testRoute(context, "/test/dream");
      let dream: TaskRow | undefined;

      await until("a finished dream", () => {
        dream = rowsOf(context, "dreaming").find((row) => !before.has(row.id) && row.status !== "working");

        return dream !== undefined;
      });

      const rows = rowsOf(context, "dreaming");
      check(dream!.status === "done", `the dream finished, got ${dream!.status}`);
      check(dream!.title === "Dreaming", `the row is titled Dreaming, got ${dream!.title}`);
      check(dream!.summary === "Dreamt.", `the dream answered, got ${dream!.summary}`);
      await testRoute(context, "/test/dream");
      check(rowsOf(context, "dreaming").length === rows.length, "a dream with nothing new adds no row");
    }
  },
  {
    name: "pair",
    expect: "pass",
    about: "`ky runner add` trades a code for a machine token, kept 0600, and ky lists the machine",
    async run(context) {
      const proxy = await startProxy(context.url);
      context.cleanup.push(() => proxy.close());
      const box = machine("paired", context.dir);
      const paired = await box.pair(proxy.url, await pairingCode(context.url));
      check(paired.code === 0 && paired.output.includes("Paired as paired."), `ky runner add paired, got ${paired.code}: ${paired.output}`);
      const mode = statSync(box.tokenFile).mode & 0o777;
      check(mode === 0o600, `the token file is 0600, got ${mode.toString(8)}`);
      check(!paired.output.includes(readFileSync(box.tokenFile, "utf8").trim()), "ky runner add never prints the token");
      await until("the paired machine in the list", () => {
        const latest = context.main.frames.findLast((frame) => frame.type === "tasks");

        return latest?.type === "tasks" && latest.machines.some((each) => each.name === "paired");
      });
      context.runner = box.launch(context.url);
      await until("the runner online with its token", () => online(context, "paired"));
    }
  },
  {
    name: "pair-code-once",
    expect: "pass",
    about: "a code pairs one machine; the same code again, or a made-up one, is refused and writes no token",
    async run(context) {
      const proxy = await startProxy(context.url);
      context.cleanup.push(() => proxy.close());
      const code = await pairingCode(context.url);
      check((await machine("first", context.dir).pair(proxy.url, code)).code === 0, "the first machine paired");

      for (const [name, tried] of [["second", code], ["guess", "not-a-code"]] as const) {
        const other = machine(name, context.dir);
        const refused = await other.pair(proxy.url, tried);
        check(refused.code === 1 && refused.output.includes("ky didn't take that code"), `${name} was refused, got ${refused.code}: ${refused.output}`);
        check(!existsSync(other.tokenFile), `${name} has no token file`);
      }
    }
  },
  {
    name: "pair-code-expired",
    expect: "pass",
    about: "a code past its ten minutes is refused and writes no token",
    async run(context) {
      const proxy = await startProxy(context.url);
      context.cleanup.push(() => proxy.close());
      const code = await pairingCode(context.url);
      await testRoute(context, `/test/vault-clock?ahead=${10 * 60_000 + 1}`);
      context.cleanup.push(() => testRoute(context, "/test/vault-clock?ahead=0"));
      const late = machine("late", context.dir);
      const refused = await late.pair(proxy.url, code);
      check(refused.code === 1 && refused.output.includes("ky didn't take that code"), `the expired code was refused, got ${refused.code}: ${refused.output}`);
      check(!existsSync(late.tokenFile), "no token file");
    }
  },
  {
    name: "token-file-loose",
    expect: "pass",
    about: "a runner refuses a machine token file others can read, and says to chmod it",
    async run(context) {
      const loose = await context.paired("loose");
      chmodSync(loose.tokenFile, 0o644);
      const runner = loose.launch(context.url);
      context.runner = runner;
      await until("the runner to exit", () => runner.exitCode() !== null);
      check(runner.exitCode() === 1, `exited 1, got ${runner.exitCode()}`);
      check(runner.output().includes("run chmod 600"), `said to chmod it, got ${runner.output()}`);
    }
  },
  {
    name: "remove-machine",
    expect: "pass",
    about: "removing a machine ends its task, and its runner exits saying to pair again; started again with the old token, it waits saying to pair again",
    async run(context) {
      const { machine: gone } = await context.machine("gone");
      const task = await startTask(context, "gone", "[delay=30000] a long job");
      await status(context, task, "working");
      check((await removeMachine(context, "gone")) === 204, "the machine was removed");
      const runner = context.runner!;
      await until("the runner to exit", () => runner.exitCode() !== null);
      check(runner.exitCode() === 1, `exited 1, got ${runner.exitCode()}`);
      check(runner.output().includes("Pair again"), `said to pair again, got ${runner.output()}`);
      await status(context, task, "failed");
      check((await removeMachine(context, "gone")) === 404, "a second remove finds no machine");

      // A runner started again with the old token is refused, and waits to try again rather than exit (#109).
      const again = gone.launch(context.url);
      context.runner = again;
      await until("the relaunched runner to say its token was refused", () => again.output().includes("Pair again"));
      check(again.exitCode() === null, `the refused runner keeps running, got exit ${again.exitCode()}`);
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
      // claude gets ky's address and its task's own token, never the machine token or the user's.
      const ky = mac.claude().find((event) => event.event === "start" && event.task === task)?.ky;
      check(ky === "KY_TASK,KY_TASK_TOKEN,KY_URL", `claude's KY_ variables are KY_TASK, KY_TASK_TOKEN and KY_URL, got ${ky}`);
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
      const old = await context.paired("old");
      const token = readFileSync(old.tokenFile, "utf8").trim();
      const socket = new Socket(`${context.url.replace(/^http/, "ws")}${RUNNER_PATH}old`, { headers: { Authorization: `Bearer ${token}` } });
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
    name: "outdated-runner-waits",
    expect: "pass",
    about: "a runner told goodbye by a ky of another protocol stays up, logs the goodbye, and says to update it",
    async run(context) {
      const proxy = await startProxy(context.url);
      context.cleanup.push(() => proxy.close());
      const newer = await context.paired("newer", proxy);
      proxy.speak(PROTOCOL + 1);
      const runner = newer.launch(proxy.url);
      context.runner = runner;

      await until("the runner to say it is outdated", () => runner.output().includes("ky upgrade"));
      check(runner.exitCode() === null, `the outdated runner keeps running, got exit ${runner.exitCode()}`);
      check(runner.output().includes(`ky said goodbye: ky speaks runner protocol ${PROTOCOL + 1}.`), `logged the goodbye, got ${runner.output()}`);
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
      check(steps === "Running `pnpm test` | Editing tasks.ts", `the steps are the tools used, got ${steps}`);
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
      check(steps.startsWith("Running `pnpm test` | Editing tasks.ts"), `codex's items show as steps, got ${steps}`);
      const start = codexStart(mac, task, 0);
      check(start.home === path.join(mac.dir, "state", "codex", task), `the task has its own CODEX_HOME, got ${start.home}`);
      check(start.auth === path.join(mac.dir, "home", ".codex", "auth.json"), `its auth.json links to the machine's, got ${start.auth}`);
      check(start.instructions === 1, "codex was told it runs a task for ky");
      await until("the report", () => context.main.heard("fake codex did: [tools=Bash:pnpm test,Edit:src/tasks.ts] fix the tests"));
    }
  },
  {
    name: "subscriptions",
    expect: "pass",
    about: "on a machine with neither CLI signed in, a Claude Code task and a Codex task run with the Vault's subscriptions",
    async run(context) {
      const claude = await subscribe(context);
      const { machine: mac, proxy } = await context.machine("bare", SIGNED_OUT);
      const task = await startTask(context, "bare", "plan the release");
      await status(context, task, "done");
      await until("claude's report", () => context.main.heard("fake claude did: plan the release"));
      const token = fingerprint(claude);
      check(mac.claude().some((event) => event.event === "start" && event.task === task && event.token === token), "claude ran with the Claude subscription token");
      const codex = await startCodex(context, "bare", "fix the tests");
      await status(context, codex, "done");
      await until("codex's report", () => context.main.heard("fake codex did: fix the tests"));
      const start = codexStart(mac, codex, 0);
      check(start.token !== "", "codex ran with ky's ChatGPT login");
      check(start.auth === "", "the login was written into its own CODEX_HOME, not linked");
      check(!existsSync(path.join(mac.dir, "state", "codex", codex, "auth.json")), "the task's auth.json is gone once codex exited");
      // The Claude token crosses one frame, the run that handed it to the runner, and is never logged or shown.
      const carrying = proxy.frames.filter((frame) => frame.includes(claude)).map((frame) => JSON.parse(frame).type);
      check(carrying.join() === "run", `the token crossed only in the run frame, got ${carrying.join() || "none"}`);
      check(!context.main.raw.some((frame) => frame.includes(claude)), "the token never reached the browser");
      check(!context.runner!.output().includes(claude), "the runner never logged the token");
      check(!readFileSync(path.join(mac.dir, "claude.jsonl"), "utf8").includes(claude), "claude's log never held the token");
    }
  },
  {
    name: "subscription-renew",
    expect: "pass",
    about: "a Codex task running on ky's ChatGPT login outlives its access token: ky pushes a fresh one before it expires",
    async run(context) {
      await subscribe(context);
      const { machine: mac, proxy } = await context.machine("renew", SIGNED_OUT);
      const task = await startCodex(context, "renew", "[delay=6000] a long migration");
      await until("codex to start", () => mac.codex().some((event) => event.event === "start" && event.task === task));
      // An hour on, the access token has under an hour left; the runner's next hello brings a fresh one.
      await testRoute(context, `/test/vault-clock?ahead=${61 * 60_000}`);
      context.cleanup.push(() => testRoute(context, "/test/vault-clock?ahead=0"));
      proxy.cut();
      await until("a creds frame", () => proxy.frames.some((frame) => JSON.parse(frame).type === "creds"), 20_000);
      await status(context, task, "done", 20_000);
      const before = codexStart(mac, task, 0).token;
      const after = mac.codex().filter((event) => event.event === "exit" && event.task === task).map((event) => event.token);
      check(before !== "", "codex started on ky's login");
      check(after.length === 1 && after[0] !== "" && after[0] !== before, `codex ended on a fresh token, got ${before} then ${after.join()}`);
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
      check(resumed.instructions === 1, "the resumed turn was told again that it runs a task for ky");
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
      // Working means the runner acked the task, not that codex is running yet: wait for its turn.
      await until("codex to start the turn", () => mac.codex().some((event) => event.event === "turn" && event.task === task));
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
    name: "codex-attach",
    expect: "pass",
    about: "a Codex task's commands get KY_TASK_TOKEN, which Codex drops by default, so ky attach shares a screenshot; never the machine token",
    async run(context) {
      const { machine: shots } = await context.machine("codexshots");
      const task = await startCodex(context, "codexshots", "[attach] screenshot the page");
      await status(context, task, "done");
      const file = sharedBy(context, task);
      check(file?.caption === "a fake screenshot", "the task lists the screenshot");
      // codex gets ky's address and its task's own token, never the machine token or the user's.
      const ky = shots.codex().find((event) => event.event === "start" && event.task === task)?.ky;
      check(ky === "KY_TASK,KY_TASK_TOKEN,KY_URL", `codex's KY_ variables are KY_TASK, KY_TASK_TOKEN and KY_URL, got ${ky}`);
    }
  },
  {
    name: "codex-home-sweep",
    expect: "pass",
    about: "the runner deletes a Codex task's home unused for two weeks, not the machine login it links to, and keeps one used since",
    async run(context) {
      const homes = path.join(context.dir, "codexsweep", "state", "codex");
      const [old, recent] = [path.join(homes, "t_old"), path.join(homes, "t_recent")];
      mkdirSync(old, { recursive: true });
      mkdirSync(recent, { recursive: true });
      const login = path.join(context.dir, "codexsweep-auth.json");
      writeFileSync(login, "{}");
      symlinkSync(login, path.join(old, "auth.json"));
      // Listed first, and a stat that follows links would throw on it.
      symlinkSync(path.join(homes, "gone"), path.join(homes, "t_broken"));
      const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60_000);
      utimesSync(old, fifteenDaysAgo, fifteenDaysAgo);
      await context.machine("codexsweep");
      await until("the old home to go", () => !existsSync(old));
      check(existsSync(recent), "the home used since is kept");
      check(existsSync(login), "the machine's login its auth.json linked to is kept");
    }
  },
  {
    name: "codex-home-fails",
    expect: "pass",
    about: "a Codex task whose home cannot be made ends failed, saying why, and the runner stays up",
    async run(context) {
      const state = path.join(context.dir, "codexnohome", "state");
      mkdirSync(state, { recursive: true });
      // A file where the homes go: making one fails, as a full or read-only disk would.
      writeFileSync(path.join(state, "codex"), "");
      await context.machine("codexnohome");
      const task = await startCodex(context, "codexnohome", "fix the tests");
      await status(context, task, "failed");
      const summary = context.main.task(task)!.summary;
      check(summary.includes("It could not start") && summary.includes("ENOTDIR"), `the result says why, got ${summary}`);
      const next = await startCodex(context, "codexnohome", "and again");
      await status(context, next, "failed");
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
      // Working means the runner acked the task, not that claude is running yet: wait for its turn.
      await until("claude to start the turn", () => mac.claude().some((event) => event.event === "turn" && event.task === task));
      await context.main.command({ type: "stop-task", task });
      await status(context, task, "stopped");
      check(mac.claude().some((event) => event.event === "sigint" && event.task === task), "claude got SIGINT");
    }
  },
  {
    name: "screenshot",
    expect: "pass",
    about: "a task shares a screenshot through ky attach and /api/files serves it",
    async run(context) {
      await context.machine("shots");
      const task = await startTask(context, "shots", "[attach] screenshot the page");
      await status(context, task, "done");
      const file = sharedBy(context, task);
      check(file !== undefined && file.caption === "a fake screenshot", "the task lists the screenshot");
      const response = await fetch(`${context.url}/files/${file!.id}`, { headers: await signedIn() });
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
  {
    name: "pipe-turn",
    expect: "pass",
    about: "main runs on Claude via VibeProxy on a machine sharing its port, and a tool-using turn streams over the pipe",
    async run(context) {
      const server = await sharingVibeProxy(context, "piped");
      await until("Claude via VibeProxy on piped", () => vibeProxyShown(context)?.name === "Claude via VibeProxy on piped" && vibeProxyShown(context)?.connected === true);
      context.main.send({ type: "submit", input: "multiply 11" });
      await until("the tool's answer", () => context.main.heard("tool said: 33"));
      const messages = server.asked.filter((path) => path.startsWith("/v1/messages"));
      check(messages.length === 2, `both of the turn's calls went over the pipe, got ${JSON.stringify(messages)}`);
    }
  },
  {
    name: "pipe-offline",
    expect: "pass",
    about: "a machine sharing VibeProxy going offline moves main to the fallback at once",
    async run(context) {
      const server = await sharingVibeProxy(context, "piped-off");
      await until("Claude via VibeProxy on piped-off", () => vibeProxyShown(context)?.name === "Claude via VibeProxy on piped-off" && vibeProxyShown(context)?.connected === true);
      await context.runner!.kill();
      await until("VibeProxy shown not connected", () => vibeProxyShown(context)?.connected === false);
      const before = server.asked.length;
      context.main.send({ type: "submit", input: "multiply 13" });
      await until("the fallback's answer", () => context.main.heard("tool said: 39"));
      check(server.asked.length === before, "nothing went to the machine while it was offline");
    }
  },
  {
    name: "pipe-refused",
    expect: "pass",
    about: "the runner refuses a request to a port it doesn't share, and the server behind a shared one never hears of it",
    async run(context) {
      const server = await sharingVibeProxy(context, "piped-refuse");
      const answer = await overPipe(context, { machine: "piped-refuse", port: "3000", path: "/elsewhere" });
      check(answer.failed === "This machine doesn't share port 3000.", `refused, got ${JSON.stringify(answer)}`);
      check(!server.asked.includes("/elsewhere"), "the request never reached a server");
    }
  },
  {
    name: "pipe-cancel",
    expect: "pass",
    about: "aborting a streaming answer over the pipe stops the request on the machine",
    async run(context) {
      const server = await sharingVibeProxy(context, "piped-cancel");
      const answer = await overPipe(context, { machine: "piped-cancel", port: String(VIBEPROXY_TEST_PORT), path: "/slow", "abort-after": "300" });
      check(answer.failed !== undefined, `the read failed, got ${JSON.stringify(answer)}`);
      await until("the machine to stop answering", () => server.dropped.includes("/slow"));
    }
  },
  {
    name: "pipe-timeout",
    expect: "pass",
    about: "a request over the pipe that gets no answer in time fails, and is cancelled on the machine",
    async run(context) {
      const server = await sharingVibeProxy(context, "piped-timeout");
      const answer = await overPipe(context, { machine: "piped-timeout", port: String(VIBEPROXY_TEST_PORT), path: "/hang", timeout: "500" });
      check(answer.failed === "No answer for 0.5s.", `timed out, got ${JSON.stringify(answer)}`);
      await until("the machine to give up", () => server.dropped.includes("/hang"));
    }
  },
  {
    name: "cloud-script",
    expect: "pass",
    about: "a task on the cloud machine wakes it, runs a script there and reports back, with no computer of the user's",
    async run(context) {
      const { host } = await cloudMachine(context);
      check(!host.running(), "the cloud machine sleeps until a task comes");
      const task = await startTask(context, CLOUD, "[sh] node -e 'console.log(6 * 7)'");
      await status(context, task, "done", 60_000);
      await until("the report", () => context.main.heard("sh exited 0: 42"));
      check(host.starts() === 1, `one container started, got ${host.starts()}`);
    }
  },
  {
    name: "cloud-refused-start",
    expect: "pass",
    about: "a start Cloudflare refuses, with no instance to give, is tried again at once, not after the 3 minutes a start may take",
    async run(context) {
      const { host } = await cloudMachine(context);
      host.refuse(2);
      const task = await startTask(context, CLOUD, "[sh] node -e 'console.log(6 * 7)'");
      // Waiting out each refused start would take 3 minutes; the test alarm retries in 2s.
      await status(context, task, "done", 30_000);
      check(host.refused() === 2 && host.starts() === 1, `two starts refused, then one container, got ${host.refused()} and ${host.starts()}`);
    }
  },
  {
    name: "cloud-claude",
    expect: "pass",
    about: "a Claude Code task on the cloud machine runs with ky's Claude subscription",
    async run(context) {
      const claude = await subscribe(context);
      const { logs } = await cloudMachine(context);
      const task = await startTask(context, CLOUD, "review the code");
      await status(context, task, "done", 60_000);
      await until("the report", () => context.main.heard("fake claude did: review the code"));
      const start = logs.claude().find((event) => event.event === "start" && event.task === task);
      check(start?.token === fingerprint(claude), `claude was handed ky's token, got ${start?.token}`);
    }
  },
  {
    name: "cloud-codex",
    expect: "pass",
    about: "a Codex task on the cloud machine runs as Codex with ky's ChatGPT login",
    async run(context) {
      await subscribe(context);
      const { logs } = await cloudMachine(context);
      const task = await startCodex(context, CLOUD, "build it in the cloud");
      await status(context, task, "done", 60_000);
      check(turns(logs, task, logs.codex()).length === 1, "codex ran it");
      const start = codexStart(logs, task, 0);
      // Written into the task's own CODEX_HOME, as for a machine not signed in; the runner deletes it when codex exits.
      check(start.auth === "" && start.token !== "", `codex was handed ky's ChatGPT login, got ${JSON.stringify(start)}`);
    }
  },
  {
    name: "cloud-follow-up",
    expect: "pass",
    about: "a message to a finished task on the cloud machine resumes its Claude session",
    async run(context) {
      const { logs } = await cloudMachine(context);
      const task = await startTask(context, CLOUD, "write the draft");
      await status(context, task, "done", 60_000);
      const first = logs.claude().find((event) => event.event === "start" && event.task === task);
      sendTo(context, task, "now polish it");
      await until("the follow-up turn", () => turns(logs, task).includes("now polish it"), 30_000);
      await until("the follow-up to finish", () => context.main.history(task).filter((entry) => entry.startsWith("done")).length >= 2);
      const resumed = logs.claude().findLast((event) => event.event === "start" && event.task === task);
      check(resumed !== undefined && resumed.resume === first?.session, "the follow-up resumed the first session");
    }
  },
  {
    name: "cloud-sleep-resume",
    expect: "pass",
    about: "the cloud machine sleeps once idle, saving its sessions to R2; a follow-up wakes a new container, which resumes the session",
    async run(context) {
      const { logs, host } = await cloudMachine(context, 3_000);
      const task = await startTask(context, CLOUD, "write the draft");
      await status(context, task, "done", 60_000);
      await until("the cloud machine to sleep", () => !host.running() && !online(context, CLOUD), 30_000);
      sendTo(context, task, "now polish it");
      await until("the follow-up turn", () => turns(logs, task).includes("now polish it"), 60_000);
      await until("the follow-up to finish", () => context.main.history(task).filter((entry) => entry.startsWith("done")).length >= 2);
      check(host.starts() === 2, `a new container woke for the follow-up, got ${host.starts()} starts`);
      // The fake claude refuses a --resume whose session file isn't there: the new container's HOME had it from R2.
      check(resumedInNewProcess(logs, task), "the new container resumed the first session");
    }
  },
  {
    name: "cloud-large-work-tree",
    expect: "pass",
    about: "a work tree bigger than one of R2's upload parts sleeps to R2 in parts and wakes whole in a new container, every file's hash the same",
    async run(context) {
      const { logs, host } = await cloudMachine(context, 3_000);
      const expected = largeTreeHash();
      const task = await startTask(context, CLOUD, `[sh] node -e '${LARGE_TREE_WRITE}' && node -e '${largeTreeHashScript("written")}'`);
      await status(context, task, "done", 60_000);
      await until("the tree's hash", () => context.main.heard(`written ${expected}`), 30_000);
      await until("the cloud machine to sleep", () => !host.running() && !online(context, CLOUD), 60_000);
      await followUp(context, logs, task, `[sh] node -e '${largeTreeHashScript("restored")}'`);
      check(host.starts() === 2, `a new container woke for the follow-up, got ${host.starts()} starts`);
      // The task can read done before its report reaches the chat; a tree that differs never prints this.
      await until("the new container's tree to have the same files, with the same hashes", () => context.main.heard(`restored ${expected}`), 30_000);
    }
  },
  {
    name: "cloud-crash-mid-task",
    expect: "pass",
    about: "the cloud container crashes during a task's second turn: that turn fails once, and a follow-up resumes the session the first turn's snapshot kept",
    async run(context) {
      const { logs, host } = await cloudMachine(context);
      const task = await startTask(context, CLOUD, "write the draft");
      await status(context, task, "done", 60_000);
      await snapshotted(context);
      sendTo(context, task, "[delay=30000] keep drafting");
      await until("the second turn to start", () => turns(logs, task).includes("[delay=30000] keep drafting"), 30_000);
      await host.crash();
      await until("the second turn to fail", () => context.main.history(task).some((entry) => entry.startsWith("failed: Interrupted")), 60_000);
      await followUp(context, logs, task, "now polish it");
      const failures = context.main.history(task).filter((entry) => entry.startsWith("failed"));
      check(failures.length === 1, `the crashed turn failed once, got ${JSON.stringify(failures)}`);
      check(host.starts() === 2, `a new container started after the crash, got ${host.starts()} starts`);
      // The fake claude refuses a --resume whose session file isn't there: the new container's HOME had it from R2.
      check(resumedInNewProcess(logs, task), "the new container resumed the first session");
    }
  },
  {
    name: "cloud-crash-while-idle",
    expect: "pass",
    about: "the cloud container dies while idle, not yet asleep, as a deploy rollout replaces it: a follow-up resumes the session from the last snapshot",
    async run(context) {
      const { logs, host } = await cloudMachine(context);
      const task = await startTask(context, CLOUD, "write the draft");
      await status(context, task, "done", 60_000);
      await snapshotted(context);
      check(host.running(), "the idle container still runs, short of its idle timeout");
      await host.crash();
      await followUp(context, logs, task, "now polish it");
      check(host.starts() === 2, `a new container woke for the follow-up, got ${host.starts()} starts`);
      // The fake claude refuses a --resume whose session file isn't there: the new container's HOME had it from R2.
      check(resumedInNewProcess(logs, task), "the new container resumed the first session");
    }
  },
  {
    name: "cloud-save-fails-then-busy",
    expect: "pass",
    about: "a sleep's save is cut off after the runner stopped; a task that comes then gets a new container with the newer files, not the older save",
    async run(context) {
      const { host } = await cloudMachine(context, 3_000);
      const task = await startTask(context, CLOUD, "[sh] echo first > first.txt");
      await status(context, task, "done", 60_000);
      sendTo(context, task, "[sh] echo written-in-turn-2 > marker.txt && echo wrote-it");
      await until("the second turn to finish", () => context.main.heard("sh exited 0: wrote-it"), 30_000);
      // Two cut off: the sleep's, and its retry's, so the task below lands while the runner is still stopped.
      host.cutSaves(2);
      await until("a save to be cut off", () => host.cutOff() >= 1, 30_000);
      check(host.running(), "the container still runs after its save was cut off");
      sendTo(context, task, "[sh] cat marker.txt");
      await until("the third turn to finish", () => context.main.heard("sh exited 0: written-in-turn-2") || context.main.heard("No such file"), 60_000);
      check(context.main.heard("sh exited 0: written-in-turn-2"), "the new container had the file the second turn wrote");
      check(host.starts() === 2, `a new container started for the task, got ${host.starts()} starts`);
    }
  },
  {
    name: "cloud-steer-folded",
    expect: "pass",
    about: "on the cloud machine, a message Claude Code folds into the running turn ends with that turn's one result",
    async run(context) {
      await cloudMachine(context);
      const task = await startTask(context, CLOUD, "[fold] [delay=3000] build the thing");
      await status(context, task, "working", 60_000);
      sendTo(context, task, "and test it");
      await until("the task to end", () => terminal(context.main.task(task)), 20_000);
      check(context.main.task(task)?.status === "done", `the task ends done, not ${context.main.task(task)?.status}`);
      await until("the report", () => context.main.heard("fake claude did: [fold] [delay=3000] build the thing + and test it"));
      await sleep(1_500);
      check(context.main.task(task)?.status === "done", "the task does not reopen as working");
    }
  },
  {
    name: "cloud-reconnect-outage",
    expect: "pass",
    about: "the cloud machine's runner, its socket cut and its first retry refused, reconnects and delivers its result",
    async run(context) {
      const { proxy } = await cloudMachine(context);
      const task = await startTask(context, CLOUD, "[delay=6000] survive an outage");
      await status(context, task, "working", 60_000);
      proxy.cut("refuse");
      await sleep(1_500);
      proxy.open();

      try {
        await until("the runner to reconnect", () => proxy.connections() >= 2, 10_000);
      } catch {
        throw new Violation("the cloud runner never reconnected after one failed retry");
      }

      await status(context, task, "done", 20_000);
      check(!context.main.history(task).some((entry) => entry.startsWith("failed")), "no false failure");
    }
  },
  {
    name: "cloud-move",
    expect: "pass",
    about: "a task queued for an offline computer moves to the cloud machine, which wakes and runs it",
    async run(context) {
      const { logs } = await cloudMachine(context);
      const { machine: away } = await context.machine("cloudaway");
      await context.runner?.stop();
      await until("cloudaway to go offline", () => !online(context, "cloudaway"));
      const task = await startTask(context, "cloudaway", "build it elsewhere");
      context.main.send({ type: "submit", input: `tool machine ${JSON.stringify({ action: "move", task, machine: CLOUD })}` });
      await status(context, task, "done", 60_000);
      check(context.main.task(task)?.worker === CLOUD, `the task moved, got ${context.main.task(task)?.worker}`);
      check(turns(logs, task).length === 1 && turns(away, task).length === 0, "it ran on the cloud machine only");
    }
  },
  {
    name: "cloud-push",
    expect: "pass",
    about: "the cloud machine clones through ky's GitHub proxy and pushes to ky/*; a push to main is refused",
    async run(context) {
      const { git } = await cloudMachine(context);
      const main = git.head("me/app", "main");

      await cloudScript(
        context,
        [
          ...kyBranch("ky/harness", "git push -q origin ky/harness && echo pushed=ky"),
          "git push -q origin HEAD:main; echo main=$?",
          "git clone -q https://github.com/me/site.git site; echo site=$?"
        ],
        "site="
      );
      check(git.branches("me/app").includes("ky/harness"), `the ky/ branch reached GitHub, got ${git.branches("me/app").join(", ")}`);
      check(context.main.heard("main=1") && git.head("me/app", "main") === main, "the push to main was refused");
      check(context.main.heard("site=128"), "a repo not picked in Settings is refused");
    }
  },
  {
    name: "cloud-github-tools",
    expect: "pass",
    about: "the cloud machine opens and merges a ky/ PR of ky's own repo with ky github, holding no token; another repo is refused",
    async run(context) {
      await cloudMachine(context);
      const saved = JSON.stringify((await context.main.command({ type: "set-repo", repo: "me/app" })).result);
      check(saved === "{}", `ky's repo was set, got ${saved}`);
      context.cleanup.push(async () => void (await context.main.command({ type: "set-repo", repo: "" })));

      await cloudScript(
        context,
        [
          `export KY_GITHUB_API=${context.url}/github.internal/api/github`,
          "env | grep -c -i -E '^(GH|GITHUB)_TOKEN=' ; echo tokens=$?",
          ...kyBranch("ky/tools", "git push -q origin ky/tools"),
          `n=$(ky github pr-create me/app main "Tools" "end to end" | sed -n 's/.*"number": \\([0-9]*\\).*/\\1/p'); echo opened=$n`,
          'ky github pr-view me/app "$n" | grep -q \'"state": "open"\' && echo viewed=open',
          'ky github pr-merge me/app "$n" | grep -q \'"state": "merged"\' && echo merged=yes',
          'ky github pr-create me/app release "Elsewhere" 2>&1 | grep -q "default branch" && echo base=refused',
          'ky github pr-merge me/site 1 2>&1 | grep -q 403 && echo site=refused'
        ],
        "site="
      );
      check(context.main.heard("tokens=1"), "the task's env has no GitHub token");
      check(context.main.heard("opened=1"), "the PR was opened");
      check(context.main.heard("viewed=open") && context.main.heard("merged=yes"), "the PR was viewed open, then merged");
      check(context.main.heard("base=refused"), "a PR into a branch that isn't the default is refused");
      check(context.main.heard("site=refused"), "a repo not picked in Settings is refused");
    }
  }
];
