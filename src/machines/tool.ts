import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { summarize, type TaskFeed, type TaskRow } from "../automations/contract";
import { toolReply as reply } from "../core/reply";
import { isRefusal } from "../core/refusal";
import { type MachineInfo, osName } from "../protocol";
import { MACHINE_ACTIONS, MACHINE_EXTENSION, MACHINE_TOOL, type MachineChange, type MachineState } from "./contract";
import { agentOf, cannotRun, PREFERRED, runs } from "./machines";
import { type Agent, AGENT_NAMES, type MachineFacts } from "./runner-protocol";
import type { MachineHub } from "./wiring";

const STEERS: ReadonlySet<Agent> = new Set(["claude"]);

function agentsOf(facts: MachineFacts): string[] {
  if (facts.kind === "cloud") return [`runs ${PREFERRED.map((agent) => AGENT_NAMES[agent]).join(" and ")} with ky's subscriptions`];

  const running = PREFERRED.flatMap((agent) => (runs(facts, agent) ? [AGENT_NAMES[agent]] : []));

  const signedOut = PREFERRED.flatMap((agent) =>
    facts.agents[agent].installed && !facts.agents[agent].signedIn ? [`${AGENT_NAMES[agent]} not signed in`] : []
  );

  return [running.length > 0 ? `runs ${running.join(" and ")}` : "runs no agent", ...signedOut];
}

function upness(machine: MachineInfo): string {
  const why = machine.reason ? `; ${machine.reason}` : "";

  if (machine.cloud === "asleep") return `asleep (wakes for a task in a minute or two)${why}`;

  if (machine.cloud === "waking") return `waking for its tasks${why}`;

  if (machine.online) return `online${why}`;

  return machine.reason ? `offline: ${machine.reason}` : "offline";
}

function whatItIs(facts: MachineFacts): string[] {
  return [osName(facts.os), facts.chrome ? "Chrome with the user's logins" : "no logged-in browser", ...agentsOf(facts)];
}

function aboutLines(machine: MachineInfo): string[] {
  const lines: string[] = [];

  if (machine.sandbox) {
    const { repos, isDefault } = machine.sandbox;

    lines.push(
      `  a sandbox, ky's own Linux machine in Cloudflare${isDefault ? ", the default" : ""}: no local files of the user's; it clones from GitHub, and pushes only to ky/* branches of ` +
        (repos.length > 0 ? `its repos: ${repos.join(", ")}` : "the repos the user picked")
    );
  }

  if (machine.note !== "") lines.push(`  the user says: ${machine.note}`);

  if (machine.facts && machine.facts.ports.length > 0) lines.push(`  shares local servers (such as local models) on ports ${machine.facts.ports.join(", ")}`);

  if (machine.facts && machine.facts.repos.length > 0) {
    lines.push(`  repos: ${machine.facts.repos.map((repo) => (repo.remote ? `${repo.name} (${repo.remote})` : repo.name)).join(", ")}`);
  }

  return lines;
}

function describeMachine(machine: MachineInfo): string {
  const parts = [machine.state, upness(machine), `${machine.active} running or queued`, ...(machine.facts ? whatItIs(machine.facts) : [])];

  return [`${machine.name}: ${parts.join(", ")}`, ...aboutLines(machine)].join("\n");
}

function factsOf(machine: MachineInfo): string {
  const parts = [machine.state, ...(machine.facts ? whatItIs(machine.facts) : ["has not said what it is yet"])];

  return [`${machine.name}: ${parts.join(", ")}`, ...aboutLines(machine)].join("\n");
}

const describeAll = (machines: readonly MachineInfo[], describe: (machine: MachineInfo) => string = describeMachine) =>
  machines.length === 0 ? "No machines yet. The user adds one in Settings, under Machines, and runs the `ky runner add` command it shows on that computer." : machines.map(describe).join("\n");

function elsewhere(machines: readonly MachineInfo[], not: string): string {
  const ready = machines.filter((machine) => machine.name !== not && machine.state === "on" && (machine.online || machine.cloud !== null));

  return ready.length === 0
    ? "No other machine is on and online."
    : `On and online: ${ready.map((machine) => `${machine.name} (${machine.online ? "" : `${machine.cloud}, wakes for it; `}${machine.active} running or queued)`).join(", ")}.`;
}

function listAll(machines: readonly MachineInfo[], feed: TaskFeed): string {
  if (machines.length === 0) return describeAll(machines);

  return machines
    .map((m) => {
      const tasks = feed
        .list(200)
        .filter((t) => t.kind === "machine" && t.worker === m.name)
        .slice(0, 8)
        .map((t) => `  ${t.id} [${t.status}] ${AGENT_NAMES[agentOf(t)]}: ${t.title}${t.summary ? ` — ${t.summary}` : ""}`);

      return [describeMachine(m), ...tasks].join("\n");
    })
    .join("\n");
}

function setMachine(hub: MachineHub, machines: readonly MachineInfo[], name: string | undefined, change: MachineChange): string {
  if (!name) return `set needs a machine.\n${describeAll(machines)}`;

  if (change.state === undefined && change.note === undefined) return "set needs a state or a note.";

  const result = hub.change(name, change);

  return isRefusal(result) ? `${result.refused}\n${describeAll(machines)}` : `Set. ${describeMachine(result)}`;
}

function defaultMachine(machines: readonly MachineInfo[]): string | undefined {
  const sandbox = machines.find((m) => m.sandbox?.isDefault && m.state === "on");

  if (sandbox) return sandbox.name;
  const ready = machines.filter((m) => m.state === "on" && m.online);

  return ready.length === 1 ? ready[0]?.name : undefined;
}

function wrongSandbox(machines: readonly MachineInfo[], target: MachineInfo, repo: string): string | null {
  const home = machines.find((m) => m.sandbox?.repos.includes(repo));

  if (!target.sandbox || home === target || (home === undefined && target.sandbox.repos.length === 0)) return null;

  return home
    ? `${repo} is the sandbox ${home.name}'s, not ${target.name}'s: run it on ${home.name}, or leave machine out. The user moves a repo between sandboxes in Settings.`
    : `${repo} is no sandbox's, and ${target.name} works only on its repos (${target.sandbox.repos.join(", ")}): name a computer for it, or the user adds it to a sandbox in Settings.`;
}

function noMachine(machines: readonly MachineInfo[]): string {
  return machines.some((m) => m.state === "on" && m.online)
    ? `Name the machine for this task.\n${describeAll(machines)}`
    : `No machine is on and online; name one to queue the task for it.\n${describeAll(machines)}`;
}

function refusalOn(machines: readonly MachineInfo[], name: string, wanted: string | undefined): string | null {
  const target = machines.find((m) => m.name === name);

  if (!target) return null;
  const wrong = wanted === undefined ? null : wrongSandbox(machines, target, wanted);

  if (wrong) return wrong;

  return target.state === "on" ? null : `${name} is ${target.state}: the user is not letting it take new tasks. ${elsewhere(machines, name)}`;
}

function homeOf(machines: readonly MachineInfo[], repo: string | undefined) {
  const wanted = repo?.trim().toLowerCase() || undefined;

  return { wanted, home: wanted === undefined ? undefined : machines.find((m) => m.sandbox?.repos.includes(wanted)) };
}

function homeRefusal(home: MachineInfo | undefined, wanted: string | undefined): string | null {
  return home && home.state !== "on" ? `${wanted} is the sandbox ${home.name}'s, which is ${home.state}: the user is not letting it take new tasks. Ask the user to turn it on.` : null;
}

function pickMachine(machines: readonly MachineInfo[], requested: string | undefined, repo?: string): { name: string } | { refusal: string } {
  const { wanted, home } = homeOf(machines, repo);
  const off = requested === undefined ? homeRefusal(home, wanted) : null;

  if (off) return { refusal: off };
  const name = requested ?? home?.name ?? defaultMachine(machines);

  if (!name) return { refusal: noMachine(machines) };
  const refusal = refusalOn(machines, name, wanted);

  return refusal ? { refusal } : { name };
}

function startedOn(hub: MachineHub, machines: readonly MachineInfo[], task: TaskRow): string {
  const started = `Started task ${task.id} on ${task.worker} as ${AGENT_NAMES[agentOf(task)]}`;

  if (hub.online(task.worker)) return `${started}.`;

  if (hub.machine(task.worker)?.cloud) return `${started} (asleep: it wakes for the task in a minute or two).`;

  const waiting = machines.some((m) => m.name === task.worker)
    ? `offline: it starts when ${task.worker} connects`
    : `no machine named ${task.worker} has connected yet: it starts when one does`;

  return `${started} (${waiting}). ${elsewhere(machines, task.worker)} move sends it elsewhere.`;
}

function moveRefusal(machines: readonly MachineInfo[], task: TaskRow, target: MachineInfo): string | null {
  if (target.state !== "on") return `${target.name} is ${target.state}: it takes no new tasks. ${elsewhere(machines, task.worker)}`;
  const from = machines.find((m) => m.name === task.worker);

  return from?.sandbox && target.sandbox && from !== target
    ? `${task.id} is on the sandbox ${from.name}, and a task doesn't move between sandboxes: each reaches only its own repos. Start a new task with its repo, and it goes to the sandbox that owns it.`
    : null;
}

function moveTask(hub: MachineHub, machines: readonly MachineInfo[], task: TaskRow, to: string | undefined): string {
  if (!to) return `move needs a machine.\n${describeAll(machines)}`;
  const target = machines.find((m) => m.name === to);

  if (!target) return `No machine ${to}.\n${describeAll(machines)}`;

  return moveRefusal(machines, task, target) ?? hub.move(task, target.name) ?? `Moved ${task.id} to ${target.name}${target.online ? "" : " (offline: it starts when it connects)"}.`;
}

type MachineArgs = {
  action: (typeof MACHINE_ACTIONS)[number];
  machine?: string;
  repo?: string;
  agent?: Agent;
  title?: string;
  prompt?: string;
  task?: string;
  message?: string;
  state?: MachineState;
  note?: string;
};

function changeOf(args: MachineArgs): MachineChange {
  const change: MachineChange = {};

  if (args.state !== undefined) change.state = args.state;

  if (args.note !== undefined) change.note = args.note;

  return change;
}

function runTask(hub: MachineHub, feed: TaskFeed, machines: readonly MachineInfo[], args: MachineArgs, id: string, conversation: string): string {
  const picked = pickMachine(machines, args.machine, args.repo);

  if ("refusal" in picked) return picked.refusal;

  if (!args.prompt?.trim()) return "run needs a prompt.";
  const agent = args.agent ?? hub.defaultAgent(picked.name);
  const refusal = cannotRun(machines.find((m) => m.name === picked.name), agent);

  if (refusal) return `${refusal} ${elsewhere(machines, picked.name)}`;
  const task = hub.start(picked.name, args.title ?? summarize(args.prompt).slice(0, 60), args.prompt, id, conversation, "chat", agent);

  if (args.title === undefined) feed.name(task.id, args.prompt);

  return startedOn(hub, machines, task);
}

function sendTask(hub: MachineHub, task: TaskRow, message: string | undefined, conversation: string): string {
  if (!message?.trim()) return "send needs a message.";

  if (hub.machine(task.worker)?.state === "off") {
    return `${task.worker} is off: the user is not letting it take anything. Start a new task elsewhere with what ${task.id} needs.`;
  }

  hub.send(task, message, conversation);

  if (task.status !== "working") return `Resuming ${task.id} with your message.`;

  const agent = agentOf(task);

  return STEERS.has(agent) ? `Steering ${task.id}.` : `Queued for ${task.id}: ${AGENT_NAMES[agent]} takes it once its turn ends.`;
}

async function onTask(hub: MachineHub, feed: TaskFeed, machines: readonly MachineInfo[], args: MachineArgs, conversation: string): Promise<string> {
  const task = args.task ? feed.get(args.task) : undefined;

  if (!task || task.kind !== "machine") return `No machine task ${args.task ?? ""}.`;

  if (args.action === "stop") {
    await hub.stop(task);

    return `Stopping ${task.id}.`;
  }

  if (args.action === "move") return moveTask(hub, machines, task, args.machine);

  return sendTask(hub, task, args.message, conversation);
}

function routing(machines: readonly MachineInfo[]): string {
  const sandboxes = machines.filter((m) => m.sandbox !== null && m.state === "on");
  const fallback = sandboxes.find((m) => m.sandbox?.isDefault);
  const personal = "Use one of the user's computers for its Chrome with the user's logins (pages behind them, and screenshots of those pages: only a machine with Chrome takes them), its local files, the local models it shares, or when the user names it. ";

  if (sandboxes.length === 0) {
    return "Choose the machine by what the user said about it, which one has the repos the task needs, which one has Chrome with the user's logins when the task needs them, and how busy each is. ";
  }

  const where =
    sandboxes.length === 1 && fallback
      ? `go to ${fallback.name}, the default when you name no machine`
      : `go to a sandbox: give run the task's repo (owner/name) and it goes to the sandbox that has it, else ${fallback ? `to ${fallback.name}, the default when you name no machine` : "name the sandbox"}`;

  return (
    `Scripts, builds, tests and work on a GitHub repo ${where}. A sandbox runs with every computer of the user's off, and wakes for a task in a minute or two. ` +
    `${personal}Among those, choose by what the user said about each, which has the repos the task needs, and how busy each is. `
  );
}

function toolDescription(machines: readonly MachineInfo[]): string {
  return (
    "Run tasks on machines, each as a Claude Code or Codex session with a shell, git, files, scripts and installed tools. " +
    "Use it when the user asks for a machine, or for what the cloud tools cannot do: running scripts, builds or tests, work on a repo, web pages that need the user's logins (have a subagent try Exa search and browse first), local files. " +
    routing(machines) +
    "Only a machine that is on takes new tasks. Name an agent only when the user asks for one, else a task runs as the machine's own, Claude Code first.\n" +
    `Machines (list says which are online and how busy):\n${describeAll(machines, factsOf)}\n` +
    "Actions: list (each machine: on, paused or off; online; how busy; OS; Chrome; which agents it runs; repos; the user's note, and its recent tasks). " +
    "run (title, prompt, machine, repo, agent): start a task; the prompt must be self-contained. Give repo only when the user or the task names the GitHub repo it works on; never guess one. " +
    "send (task, message): steer a working task, or resume a finished one with its history; it goes to the task's own agent. Codex takes no message mid-turn: one sent to a working Codex task runs once its turn ends. " +
    "stop (task): stop it; send resumes it later. " +
    "move (task, machine): send a task that has not started yet to another machine that runs its agent, such as when its machine is offline. " +
    "set (machine, state, note): only when the user asks; state on, paused (finishes its tasks, takes no new ones) or off (takes nothing from you); note says what it is for. " +
    "Results are reported back to this conversation as messages when they arrive; do not poll."
  );
}

export function machineExtension(hub: MachineHub, feed: TaskFeed): Extension {
  return defineExtension({
    name: MACHINE_EXTENSION,
    tools: [
      defineTool({
        name: MACHINE_TOOL,
        get description() {
          return toolDescription(hub.machines());
        },
        parameters: Type.Object({
          action: Type.Union(MACHINE_ACTIONS.map((action) => Type.Literal(action))),
          machine: Type.Optional(Type.String()),
          repo: Type.Optional(Type.String({ description: "The GitHub repo (owner/name) a run works on: it goes to the sandbox that has it." })),
          agent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")], { description: "claude (Claude Code) or codex (Codex)." })),
          title: Type.Optional(Type.String({ description: "3-6 words for the task list." })),
          prompt: Type.Optional(Type.String()),
          task: Type.Optional(Type.String({ description: "A task id from run or list." })),
          message: Type.Optional(Type.String()),
          state: Type.Optional(Type.Union([Type.Literal("on"), Type.Literal("paused"), Type.Literal("off")])),
          note: Type.Optional(Type.String({ description: "What the machine is for, in the user's words; empty clears it." }))
        }),
        replay: "unsafe",
        execute: async (args, api) => {
          const machines = hub.machines();
          const conversation = String(api.conversationId);

          if (args.action === "list") return reply(listAll(machines, feed));

          if (args.action === "set") return reply(setMachine(hub, machines, args.machine, changeOf(args)));

          if (args.action === "run") return reply(runTask(hub, feed, machines, args, `m-${String(api.taskId)}`, conversation));

          return reply(await onTask(hub, feed, machines, args, conversation));
        }
      })
    ]
  });
}
