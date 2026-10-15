/**
 * `ky runner add|run|ls|status|logs|rm|cloud`, and `ky attach` and `ky diff`, which tasks run. Each
 * takes the run's context, whose `system` the tests replace with a temporary home and fakes of
 * `security`, `launchctl` and `systemctl`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { confirm, isCancel, multiselect, text } from "@clack/prompts";
import Type from "typebox";
import { bodyAs, parseOr } from "../../src/core/decode.ts";
import { AGENT_NAMES, type Agent, type MachineFacts } from "../../src/machines/contract.ts";
import type { Context } from "../commands.ts";
import { bold, cancelled, dim, green, type Output, output, red, terminal } from "../output.ts";
import { ASK, type AgentFacts, repoFolders, scanRepos } from "./facts.ts";
import { cloudCommand } from "./cloud.ts";
import { checkoutVersion, runRunner, type Status, StatusSchema, statusFile } from "./run.ts";
import { logFile, service, serviceDirs } from "./service.ts";
import { kyUrl, LOCAL_SERVERS, machineName, readSettings, removeSettings, type Settings, settingsFile, withEnv, writeSettings } from "./settings.ts";
import { github } from "./github.ts";
import { attach, diff } from "./share.ts";
import { asInstance, compiled, defaultWorkdir, type System } from "./system.ts";
import { deleteToken, describeStore, keychainRemoval, readToken, tokenStore, writeToken } from "./token.ts";

export type RunnerFlags = { name?: string; as?: string; replace?: boolean; yes?: boolean; "no-service"?: boolean; follow?: boolean; json?: boolean };

/** How long `ky runner add` waits for the service's runner to come online. */
const ONLINE_WITHIN_MS = 60_000;

/** How long a runner must stay online to count: a refused pairing is closed just after it opens. */
const SETTLED_MS = 2_000;

const POLL_MS = 500;

/** What `ky runner add` found on this computer. */
type Found = { agents: Record<Agent, AgentFacts>; chrome: boolean; folders: { folder: string; repos: number }[]; ports: { port: number; name: string }[] };

async function detect(context: Context): Promise<Found> {
  const { env, system } = context;
  const [claude, codex] = await Promise.all([ASK.claude(env.KY_CLAUDE ?? "claude"), ASK.codex(env.KY_CODEX ?? "codex")]);
  const open = await Promise.all(LOCAL_SERVERS.map(async (server) => ((await system.listening(server.port)) ? [server] : [])));

  return {
    agents: { claude: claude ?? { installed: true, signedIn: false }, codex: codex ?? { installed: true, signedIn: false } },
    chrome: system.chrome(),
    folders: repoFolders(system.home),
    ports: open.flat()
  };
}

function answered<T>(answer: T): Exclude<T, symbol> {
  if (isCancel(answer)) cancelled();

  // SAFETY: isCancel is true for every symbol clack answers with.
  return answer as Exclude<T, symbol>;
}

const login = (facts: AgentFacts) => (facts.signedIn ? "signed in" : "not signed in; ky can hand it your subscription");

/** What to share: asked at a terminal, else everything found but Chrome, whose logins are the user's to give. */
async function choose(found: Found, ask: boolean, workdir: string): Promise<Pick<Settings, "agents" | "chrome" | "repos" | "ports">> {
  const folders = found.folders.map(({ folder }) => folder);

  if (!ask) return { agents: { claude: found.agents.claude.installed, codex: found.agents.codex.installed }, chrome: false, repos: folders.length > 0 ? folders : [workdir], ports: found.ports.map(({ port }) => port) };

  const agents = { claude: false, codex: false };

  for (const agent of ["claude", "codex"] as const) {
    if (found.agents[agent].installed) agents[agent] = answered(await confirm({ message: `Run ${AGENT_NAMES[agent]} tasks here? (${login(found.agents[agent])})` }));
  }

  const chrome = found.chrome && answered(await confirm({ message: "Let Claude Code tasks use your Chrome, with its logins?", initialValue: false }));

  const repos =
    folders.length === 0
      ? [workdir]
      : answered(
          await multiselect({
            message: "Which folders of repositories should ky know about?",
            options: found.folders.map(({ folder, repos: count }) => ({ value: folder, label: folder, hint: `${count} repositor${count === 1 ? "y" : "ies"}` })),
            initialValues: folders,
            required: false
          })
        );

  const ports: number[] = [];

  for (const { port, name } of found.ports) {
    if (answered(await confirm({ message: `Share ${name} (port ${port}) with ky, as a model on this machine?` }))) ports.push(port);
  }

  return { agents, chrome, repos, ports };
}

/** What a pairing sends: the machine as it will be shared. */
function factsFor(settings: Settings, found: Found): MachineFacts {
  const agent = (name: Agent) => (settings.agents[name] ? found.agents[name] : { installed: false, signedIn: false });

  return { os: process.platform, chrome: settings.chrome, repos: scanRepos(settings.repos), agents: { claude: agent("claude"), codex: agent("codex") }, ports: settings.ports, kind: "computer" };
}

/** What ky's /api/runners/pair answers with a 200. */
const Paired = Type.Object({ machine: Type.String(), token: Type.String() });

/** Trades a pairing code for the machine's token (C2). */
async function pair(url: string, code: string, name: string, facts: MachineFacts): Promise<{ machine: string; token: string }> {
  const response = await fetch(`${url}/api/runners/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim(), name, facts })
  });

  if (response.status === 401) throw new Error("ky didn't take that code: it's wrong, used, or older than ten minutes. Make a new one in Settings, Machines, Add a machine");

  if (!response.ok) throw new Error(`ky refused to pair (HTTP ${response.status}): ${(await response.text()).trim()}`);

  return bodyAs(response, Paired, "ky's answer to pairing");
}

async function readStatus(state: string): Promise<Status | undefined> {
  try {
    return parseOr(StatusSchema, await readFile(statusFile(state), "utf8"), undefined);
  } catch {
    return undefined;
  }
}

/** Whether a runner that said it was online still is, as the same process, a moment later. */
async function stayed(state: string, status: Status, sleep: (ms: number) => Promise<void>): Promise<Status | undefined> {
  await sleep(SETTLED_MS);
  const after = await readStatus(state);

  return after?.state === "online" && after.pid === status.pid ? after : undefined;
}

/** Waits for a runner started after `since` to come online and stay so; the status it ended on. */
async function online(state: string, since: number, sleep: (ms: number) => Promise<void>): Promise<Status | undefined> {
  let status: Status | undefined;

  for (let waited = 0; waited < ONLINE_WITHIN_MS; waited += POLL_MS) {
    status = await readStatus(state);
    const fresh = status && status.at >= since ? status : undefined;

    if (fresh?.state === "stopped") return fresh;
    const settled = fresh?.state === "online" ? await stayed(state, fresh, sleep) : undefined;

    if (settled) return settled;
    await sleep(POLL_MS);
  }

  return status;
}

/** A prompt's answer, or the positional given, or nothing without a terminal. */
async function given(value: string | undefined, message: string, placeholder: string): Promise<string | undefined> {
  if (value || !terminal()) return value;

  return answered(await text({ message, placeholder }));
}

/** What `detect` found, in words. */
function foundWords(found: Found): string {
  const names = [found.agents.claude.installed && "Claude Code", found.agents.codex.installed && "Codex", found.chrome && "Chrome", ...found.ports.map(({ name }) => name)];

  return names.filter(Boolean).join(", ") || "no agents yet";
}

/** Why `ky runner add` won't pair this runner with `url`: it is another ky's, and pairing would take it from that ky. */
function taken(system: System, theirs: string, url: string): string {
  const runner = system.instance ? `The runner ${system.instance} on this computer` : "This computer's runner";
  const beside = system.instance ? "pick another name for --as" : "add --as <name>, such as --as work";

  return `${runner} is for ${theirs}. To add one for ${url} beside it, ${beside}. To move it to ${url}, which takes it from ${theirs}, add --replace`;
}

/** The runner `ky runner add` replaces, if any; refused when it is another ky's and `replace` isn't given. Checked before pairing, so a refusal leaves the code unused. */
async function earlier(context: Context, url: string, replace: boolean): Promise<Settings | undefined> {
  const before = await saved(context).catch(() => undefined);

  if (before && kyUrl(before.url) !== url && !replace) throw new Error(taken(context.system, before.url, url));

  return before;
}

/** The earlier pairing's token stays in the Keychain: removing it is the user's call. */
function leftover(out: Output, before: Settings | undefined): void {
  const removal = before && keychainRemoval(before.token);

  if (removal) out.done(`The earlier token is still in the Keychain, and no longer used. Remove it: ${bold(removal)}`);
}

/** Pairs this computer with what the user shares, and keeps its token and runner.json; its settings. */
async function pairHere(context: Context, out: Output, positionals: string[], flags: RunnerFlags): Promise<Settings> {
  const { system, env } = context;
  const typedUrl = await given(positionals[0], "Your ky's URL", "https://ky.you.workers.dev");
  const code = await given(positionals[1], "The code from ky's Settings, Machines, Add a machine", "");

  if (!typedUrl || !code) throw new Error("usage: ky runner add <ky url> <code>; the code is in ky's Settings, Machines, Add a machine");
  const url = kyUrl(typedUrl);
  const before = await earlier(context, url, Boolean(flags.replace));
  const name = machineName(flags.name ?? env.KY_MACHINE);
  const workdir = env.KY_WORKDIR ?? defaultWorkdir(system);
  const found = await out.waiting("Looking at what this computer has", () => detect(context));

  out.done(`Found ${foundWords(found)}`);
  const shared = await choose(found, terminal() && !flags.yes, workdir);
  const settings: Settings = { url, name, token: tokenStore(system, env), workdir, permissionMode: env.KY_PERMISSION_MODE ?? "bypassPermissions", ...shared };
  const paired = await out.waiting(`Pairing with ${url}`, () => pair(url, code, name, factsFor(settings, found)));

  settings.name = paired.machine;
  await writeToken(system, settings.token, paired.token);
  await writeSettings(settingsFile(system), settings);
  out.done(`Paired as ${bold(paired.machine)}. Its token is in ${describeStore(settings.token)}`);
  leftover(out, before);

  return settings;
}

async function addCommand(context: Context, positionals: string[], flags: RunnerFlags): Promise<number> {
  const out = output(context.print);

  out.intro("ky runner add");
  const { name } = await pairHere(context, out, positionals, flags);
  const manager = service(context.system);

  if (flags["no-service"] || !manager) {
    out.outro(`Paired as ${name}. Start it: ${bold("ky runner run")}`);

    return 0;
  }

  const since = Date.now();
  const dirs = Object.entries(serviceDirs(context.system)).map(([name, value]) => `${name}=${value}`);

  // A trial's setting would stay in the service: say so, as it is kept until the next `ky runner add`.
  if (dirs.length > 0) out.done(`The service keeps ${dirs.join(" and ")}, as this shell has it. For the default, unset it and run ky runner add again`);
  await out.waiting("Installing the runner as a service", () => manager.install());
  const status = await out.waiting("Waiting for ky to show it online", () => online(context.system.state, since, context.sleep));

  if (status?.state !== "online") {
    out.outro(red(`${name} isn't online yet${status?.reason ? `: ${status.reason}` : ""}. See ${bold("ky runner logs")}`));

    return 1;
  }

  out.outro(`${green(`${name} is online`)} in ky. Send it a task from the chat.`);

  return 0;
}

/** This computer's runner, as `ky runner add` set it up, else undefined. */
async function saved(context: Context): Promise<Settings | undefined> {
  return readSettings(settingsFile(context.system));
}

async function settingsOrFail(context: Context): Promise<Settings> {
  const settings = await saved(context);

  if (!settings) {
    const which = context.system.instance ? `no runner named ${context.system.instance}` : "no runner";

    throw new Error(`This computer has ${which}. Add one: in ky, open Settings, Machines, Add a machine, and run the command it shows`);
  }

  return settings;
}

async function runCommand(context: Context): Promise<number> {
  const { system, env } = context;
  const settings = withEnv(await saved(context), env, system);
  const token = await readToken(system, settings.token);
  const version = compiled() ? (await context.release()).version : checkoutVersion();

  await runRunner({ settings, token, state: system.state, version, ky: system.ky, service: env.KY_RUNNER_SERVICE === "1" });

  return 0;
}

const since = (at: number) => `${new Date(at).toLocaleString()}`;

const STATE_WORDS: Record<Status["state"], (text: string) => string> = { online: green, stopped: red, offline: dim };

/** `online since …`, from the runner's own status; offline when nothing runs it. */
function stateOf(status: Status | undefined, loaded: boolean | undefined): string {
  if (!status) return loaded === false ? "not running" : "never started";

  return `${STATE_WORDS[status.state](status.state)} since ${since(status.at)}${status.reason ? dim(` (${status.reason})`) : ""}`;
}

/** The second runners on this computer, each as `--as` sees it: a folder of ~/.config/ky with a runner.json. */
async function instances(system: System): Promise<System[]> {
  const folders = await readdir(path.join(system.config, "ky"), { withFileTypes: true }).catch(() => []);

  return folders.flatMap((folder) => {
    if (!folder.isDirectory()) return [];

    try {
      const instance = asInstance(system, folder.name);

      return existsSync(settingsFile(instance)) ? [instance] : [];
    } catch {
      return [];
    }
  });
}

/** This computer's runners: the first, if it has one, and each second runner, unless `--as` names one. */
async function runners(context: Context): Promise<System[]> {
  const here = existsSync(settingsFile(context.system)) ? [context.system] : [];

  return context.system.instance ? here : [...here, ...(await instances(context.system))];
}

async function lsCommand(context: Context): Promise<number> {
  const found = await runners(context);

  if (found.length === 0) {
    context.print("No runner on this computer. Add one: ky runner add <ky url> <code>");

    return 0;
  }

  for (const system of found) {
    const settings = await settingsOrFail({ ...context, system });
    const status = await readStatus(system.state);
    const as = system.instance ? dim(`  --as ${system.instance}`) : "";

    context.print(`${bold(settings.name)}  ${settings.url}  ${stateOf(status, await service(system)?.loaded())}${as}`);
  }

  return 0;
}

async function statusCommand(context: Context, json: boolean): Promise<number> {
  const settings = await settingsOrFail(context);
  const manager = service(context.system);
  const installed = manager && { file: manager.file, loaded: await manager.loaded() };
  const status = await readStatus(context.system.state);
  const lines = json ? [JSON.stringify({ settings, service: installed, status: status ?? null }, null, 2)] : statusLines(context.system, settings, status, installed);

  for (const line of lines) context.print(line);

  return status?.state === "online" ? 0 : 1;
}

/** `ky runner status`'s lines. */
function statusLines(system: System, settings: Settings, status: Status | undefined, manager: { file: string; loaded: boolean } | undefined): string[] {
  const agents = (["claude", "codex"] as const).flatMap((agent) => (settings.agents[agent] ? [AGENT_NAMES[agent]] : []));
  const row = (label: string, value: string) => `${label.padEnd(9)} ${value}`;

  return [
    row("Machine", `${bold(settings.name)} on ${settings.url}`),
    row("State", `${stateOf(status, manager?.loaded)}${status ? dim(`, ky ${status.version}`) : ""}`),
    row("Runs", `${agents.join(", ") || "no agents"}${settings.chrome ? ", with your Chrome" : ""}, in ${settings.workdir}`),
    row("Repos", settings.repos.join(", ")),
    row("Ports", settings.ports.join(", ") || "none"),
    row("Token", describeStore(settings.token)),
    row("Service", manager ? `${manager.file} (${manager.loaded ? "loaded" : "not loaded"})` : "none on this OS; run ky runner run"),
    row("Log", logFile(system))
  ];
}

async function logsCommand(context: Context, follow: boolean): Promise<number> {
  const log = logFile(context.system);

  if (!existsSync(log)) throw new Error(`No log at ${log} yet: the runner logs there once its service starts`);

  if (!follow) {
    const lines = (await readFile(log, "utf8")).trimEnd().split("\n");

    context.print(lines.slice(-100).join("\n"));

    return 0;
  }

  return new Promise((resolve) => spawn("tail", ["-n", "100", "-f", log], { stdio: "inherit" }).on("close", (code) => resolve(code ?? 0)));
}

/** Takes the runner off this computer: its service, token, settings and status. ky keeps the machine until it is removed there. */
async function rmCommand(context: Context): Promise<number> {
  const { system } = context;
  const settings = await settingsOrFail(context);

  await service(system)?.uninstall();
  await deleteToken(system, settings.token);
  await removeSettings(settingsFile(system));
  await rm(statusFile(system.state), { force: true });
  context.print(`Removed ${settings.name}${system.instance ? ` (--as ${system.instance})` : ""} from this computer. ky still lists it: remove it there in Settings, Machines, which also revokes its token.`);

  return 0;
}

/** Restarts this computer's runner services, each that is loaded, so they run this `ky`; what it did, if anything. */
export async function restartRunner(context: Context): Promise<string | undefined> {
  const restarted: string[] = [];

  for (const system of await runners(context)) {
    const settings = await saved({ ...context, system });
    const manager = service(system);

    if (!settings || !manager || !(await manager.loaded())) continue;
    await manager.restart();
    restarted.push(settings.name);
  }

  return restarted.length > 0 ? `Restarted the runner for ${restarted.join(" and ")}` : undefined;
}

export async function runnerCommand(given: Context, positionals: string[], flags: RunnerFlags): Promise<number> {
  const [command, ...rest] = positionals;
  // A second runner, for another ky: `--as`, or KY_RUNNER_AS, which its service sets.
  const as = flags.as ?? (given.env.KY_RUNNER_AS || undefined);
  const context = as ? { ...given, system: asInstance(given.system, as) } : given;

  const commands = new Map<string, () => Promise<number>>([
    ["add", () => addCommand(context, rest, flags)],
    ["run", () => runCommand(context)],
    ["ls", () => lsCommand(context)],
    ["status", () => statusCommand(context, flags.json ?? false)],
    ["logs", () => logsCommand(context, flags.follow ?? false)],
    ["rm", () => rmCommand(context)],
    // The cloud machine's container runs this; nothing else does.
    ["cloud", () => cloudCommand(context)]
  ]);

  const run = commands.get(command ?? "");

  if (!run) throw new Error(`usage: ky runner ${[...commands.keys()].join("|")}`);

  return run();
}

/** `ky github …`, inside a task on the cloud machine. */
export function githubCommand(context: Context, args: string[]): Promise<number> {
  return github(args, context.env, context.print, context.sleep);
}

/** `ky attach` or `ky diff`, inside a task. */
export async function shareCommand(context: Context, what: "attach" | "diff", args: string[]): Promise<number> {
  context.print(await (what === "attach" ? attach : diff)(args, context.env));

  return 0;
}
