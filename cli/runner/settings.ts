/**
 * ~/.config/ky/runner.json: this computer's runner, as `ky runner add` set it up (a second runner's
 * is ~/.config/ky/<as>/runner.json). Which ky it
 * joins and as what name, where its token is kept, and what it shares: which agents, the user's
 * Chrome, which folders of repositories, and which local ports (a model server such as VibeProxy
 * or Ollama). `ky runner run` reads it; each AGENT_ variable below overrides its setting, and with no
 * file the variables alone describe the runner, as the harness runs it. Each is still read under its
 * old KY_ name too, until PR5b (src/machines/wire-names.ts).
 *
 *   AGENT_URL            the ky it joins
 *   AGENT_MACHINE        its name in ky (default: this host's name)
 *   AGENT_RUNNER_TOKEN_FILE keep the machine token in this file (mode 600), not ~/.config/ky/runner-token
 *   AGENT_WORKDIR        where tasks run (default: ~/ky-work)
 *   AGENT_PERMISSION_MODE Claude Code's permission mode (default: bypassPermissions)
 *   AGENT_CHROME         1: tasks drive the user's Chrome, with its logins (Claude in Chrome)
 *   AGENT_REPOS          folders, split by ":", whose git repositories ky is told about (default: the workdir)
 *   AGENT_RUNNER_PORTS   ports, split by ",", that ky may send HTTP requests to, e.g. 8317 for VibeProxy
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { type Static, Type } from "typebox";
import { parseOr } from "../../src/core/decode.ts";
import { defaultWorkdir, kyConfig, type System } from "./system.ts";
import { fromEnv } from "../../src/machines/contract.ts";

/** Where the machine token is kept: a file only the user can read, or a Keychain item (macOS, paired before ky kept it in the file). */
const TokenStoreSchema = Type.Union([
  Type.Object({ keychain: Type.Object({ service: Type.String(), account: Type.String() }) }),
  Type.Object({ file: Type.String() })
]);

export type TokenStore = Static<typeof TokenStoreSchema>;

const SettingsSchema = Type.Object({
  url: Type.String(),
  name: Type.String(),
  token: TokenStoreSchema,
  workdir: Type.String(),
  repos: Type.Array(Type.String()),
  permissionMode: Type.String(),
  chrome: Type.Boolean(),
  agents: Type.Object({ claude: Type.Boolean(), codex: Type.Boolean() }),
  ports: Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }))
});

export type Settings = Static<typeof SettingsSchema>;

/** The local servers a runner may share, by the port they listen on. */
export const LOCAL_SERVERS: readonly { port: number; name: string }[] = [
  { port: 8317, name: "VibeProxy" },
  { port: 11_434, name: "Ollama" }
];

export function settingsFile(system: System): string {
  return path.join(kyConfig(system), "runner.json");
}

/** This machine's name in ky, from `name`, else the host's: lower case, as a runner path allows it. */
export function machineName(name = hostname().split(".")[0] ?? ""): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32);
}

/** ky's URL without a trailing slash; a bare host is taken as https. */
export function kyUrl(url: string): string {
  const full = /^https?:\/\//.test(url) ? url : `https://${url}`;

  return new URL(full).origin;
}

/** The settings `ky runner add` wrote, or undefined before it has. */
export async function readSettings(file: string): Promise<Settings | undefined> {
  let text: string;

  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }

  const settings = parseOr(SettingsSchema, text, undefined);

  if (!settings) throw new Error(`${file} isn't a runner's settings; run \`ky runner add\` again`);

  return settings;
}

export async function writeSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const next = `${file}.${process.pid}`;

  await writeFile(next, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(next, file);
}

export async function removeSettings(file: string): Promise<void> {
  await rm(file, { force: true });
}

const portsOf = (text: string) =>
  text
    .split(",")
    .map(Number)
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535);

const split = (text: string) => text.split(":").filter((root) => root !== "");

/** A variable's value read with `parse`, or `otherwise` when it isn't set. */
function override<T>(value: string | undefined, parse: (text: string) => T, otherwise: T): T {
  return value === undefined ? otherwise : parse(value);
}

/** The settings of a runner with no runner.json: its token in its file, everything else the default. */
function defaults(url: string, system: System): Settings {
  return {
    url,
    name: machineName(),
    token: { file: path.join(kyConfig(system), "runner-token") },
    workdir: defaultWorkdir(system),
    repos: [],
    permissionMode: "bypassPermissions",
    chrome: false,
    agents: { claude: true, codex: true },
    ports: []
  };
}

/**
 * The settings `ky runner run` runs with: the file's, each overridden by its KY_ variable. With
 * no file, KY_URL is required and the rest default; the token is then in its file.
 */
export function withEnv(saved: Settings | undefined, env: NodeJS.ProcessEnv, system: System): Settings {
  const url = fromEnv(env, "URL") ?? saved?.url;

  if (!url) throw new Error("This computer has no runner yet. In ky, open Settings, Machines, Add a machine, and run the command it shows.");
  const base = saved ?? defaults(url, system);
  const workdir = fromEnv(env, "WORKDIR") ?? base.workdir;

  return {
    ...base,
    url: kyUrl(url),
    name: override(fromEnv(env, "MACHINE") || undefined, machineName, base.name),
    token: override(fromEnv(env, "RUNNER_TOKEN_FILE"), (file) => ({ file }), base.token),
    workdir,
    // A runner with no runner.json tells ky about the repos in its workdir.
    repos: override(fromEnv(env, "REPOS"), split, saved ? base.repos : [workdir]),
    permissionMode: fromEnv(env, "PERMISSION_MODE") ?? base.permissionMode,
    chrome: override(fromEnv(env, "CHROME"), (value) => value === "1", base.chrome),
    ports: override(fromEnv(env, "RUNNER_PORTS"), portsOf, base.ports)
  };
}
