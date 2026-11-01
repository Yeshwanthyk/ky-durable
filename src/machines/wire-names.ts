/**
 * The names the runner and the Worker use for each other: environment variables and headers.
 *
 * They are moving from ky's own `KY_` and `X-Ky-` names to neutral `AGENT_` and `X-Agent-` ones, so
 * the protocol never carries the product's name. This is step one of two (PR5): whoever writes a
 * name writes both, whoever reads one prefers the new name and falls back to the old. A runner or
 * cloud image from before the change then works against a new Worker, and a new one against an old
 * Worker. PR5b, once a release with this has reached the cloud image and the owner's runners, drops
 * every `KY_` and `X-Ky-` name below: `LEGACY_ENV`, `LEGACY_HEADERS` and their uses.
 */

/** Each variable a runner, the cloud machine or a task reads, by its name after the prefix. */
const RUNNER_VARS = [
  // What the CloudMachine starts the container with, and `ky runner run`'s settings.
  "URL",
  "MACHINE",
  "RUNNER_TOKEN",
  "RUNNER_TOKEN_FILE",
  "WORKDIR",
  "PERMISSION_MODE",
  "CHROME",
  "REPOS",
  "RUNNER_PORTS",
  "CLAUDE",
  "CODEX",
  "STATE_DIR",
  "RUNNER_PROBE_MS",
  // What the service file sets.
  "RUNNER_SERVICE",
  "RUNNER_AS",
  // The cloud machine's own.
  "CLOUD_PORT",
  "GITHUB_PROXY",
  "GITHUB_API",
  // What the runner gives each task.
  "TASK",
  "TASK_TOKEN"
] as const;

export type RunnerVar = (typeof RUNNER_VARS)[number];

const ENV_PREFIX = "AGENT_";

/** PR5b removes: the old prefix. */
const LEGACY_ENV = "KY_";

/** The variable's name, as it is written and read now. */
const envName = (name: RunnerVar) => `${ENV_PREFIX}${name}`;

/** Every name the variable goes by: PR5b leaves only `envName`. */
export const envNames = (name: RunnerVar) => [envName(name), `${LEGACY_ENV}${name}`];

/** A variable from `env`: its new name, else (PR5b removes) its old one. */
export function fromEnv(env: Readonly<Record<string, string | undefined>>, name: RunnerVar): string | undefined {
  return env[envName(name)] ?? env[`${LEGACY_ENV}${name}`];
}

/** `vars` as the environment a runner or task is given: each under its new name and (PR5b removes) its old one. */
export function toEnv(vars: Partial<Record<RunnerVar, string>>): Record<string, string> {
  return Object.fromEntries(RUNNER_VARS.flatMap((name) => {
    const value = vars[name];

    return value === undefined ? [] : envNames(name).map((key) => [key, value]);
  }));
}

/** Whether `key` is one of the runner's own variables, which a task never inherits from it: any `KY_` (PR5b removes), or a known `AGENT_` one. */
export function isRunnerEnv(key: string): boolean {
  return key.startsWith(LEGACY_ENV) || (key.startsWith(ENV_PREFIX) && RUNNER_VARS.some((name) => key === envName(name)));
}

/** The headers between a runner (or a task) and the Worker. */
export const HEADERS = {
  /** The pairing a machine token was minted for, which the Worker names to the agent. */
  pairing: "X-Agent-Pairing",
  /** A file's name, URI-encoded, on an upload. */
  name: "X-Agent-Name",
  /** A file's caption, URI-encoded, on an upload. */
  caption: "X-Agent-Caption"
} as const;

export type Header = keyof typeof HEADERS;

const HEADER_KEYS: readonly Header[] = ["pairing", "name", "caption"];

/** PR5b removes: each header's old name. */
const LEGACY_HEADERS: Readonly<Record<Header, string>> = { pairing: "X-Ky-Pairing", name: "X-Ky-Name", caption: "X-Ky-Caption" };

/** Every name the header goes by: PR5b leaves only `HEADERS[header]`. */
const headerNames = (header: Header) => [HEADERS[header], LEGACY_HEADERS[header]];

/** A header from a request: its new name, else (PR5b removes) its old one. */
export function readHeader(headers: Headers, header: Header): string | null {
  return headers.get(HEADERS[header]) ?? headers.get(LEGACY_HEADERS[header]);
}

/** `values` as request headers: each under its new name and (PR5b removes) its old one. */
export function toHeaders(values: Partial<Record<Header, string>>): Record<string, string> {
  return Object.fromEntries(HEADER_KEYS.flatMap((header) => {
    const value = values[header];

    return value === undefined ? [] : headerNames(header).map((key) => [key, value]);
  }));
}

/** Set `value` as `header` on `headers`, under every name it goes by, so a sender can't leave one of them set to its own. */
export function setHeader(headers: Headers, header: Header, value: string): void {
  for (const name of headerNames(header)) headers.set(name, value);
}
