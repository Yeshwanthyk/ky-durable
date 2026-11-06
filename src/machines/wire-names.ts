/**
 * The names the runner and the Worker use for each other: environment variables and headers.
 *
 * They are moving from ky's own `KY_` and `X-Ky-` names to `SELF_HOSTED_AGENT_` and
 * `X-Self-Hosted-Agent-` ones (the neutral identity `ky deploy` uses, `self-hosted-agent`), so the
 * protocol never carries the product's name. The prefix is long on purpose: a bare `AGENT_` is
 * one a shell or CI sets for itself (`AGENT_URL` would point `ky runner run` and its machine token
 * at another server). This is step one of two (PR5): a reader prefers the new name and falls back
 * to the old; a writer writes both, except a secret, which goes under its old name only (below). A
 * runner or cloud image from before the change then works against a new Worker, and a new one
 * against an old Worker. PR5b, once a release with this has reached the cloud image and the
 * owner's runners, drops every `KY_` and `X-Ky-` name below (`LEGACY_ENV`, `LEGACY_HEADERS` and
 * their uses) and flips `SECRET_VARS` to the new name only.
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

const ENV_PREFIX = "SELF_HOSTED_AGENT_";

/** PR5b removes: the old prefix. */
const LEGACY_ENV = "KY_";

/**
 * The secrets: the machine token, the file that holds one, and a task's own token. Until PR5b they
 * are written under their old `KY_` name only, and PR5b writes them under the new name only.
 *
 * The cloud machine runs the last released image, which is older than the Worker that starts it,
 * and an old runner deletes only `KY_RUNNER_TOKEN` from its env and drops only `KY_` names from a
 * task's. A secret under the new name would reach every task it runs. A new runner reads the old
 * name through `fromEnv`'s fallback.
 */
const SECRET_VARS: ReadonlySet<RunnerVar> = new Set(["RUNNER_TOKEN", "RUNNER_TOKEN_FILE", "TASK_TOKEN"]);

/** The variable's name, as it is written and read now. */
const envName = (name: RunnerVar) => `${ENV_PREFIX}${name}`;

/** PR5b removes: the variable's old name. */
const legacyName = (name: RunnerVar) => `${LEGACY_ENV}${name}`;

/** Every name the variable goes by, to read or delete it: PR5b leaves only `envName`. */
export const envNames = (name: RunnerVar) => [envName(name), legacyName(name)];

/** The names `toEnv` writes the variable under: a secret's old one only, for now (`SECRET_VARS`). */
const writtenNames = (name: RunnerVar) => (SECRET_VARS.has(name) ? [legacyName(name)] : envNames(name));

/** A variable from `env`: its new name, else (PR5b removes) its old one. */
export function fromEnv(env: Readonly<Record<string, string | undefined>>, name: RunnerVar): string | undefined {
  return env[envName(name)] ?? env[legacyName(name)];
}

/** `vars` as the environment a runner or task is given: each under its new name and (PR5b removes) its old one, a secret under its old one only. */
export function toEnv(vars: Partial<Record<RunnerVar, string>>): Record<string, string> {
  return Object.fromEntries(RUNNER_VARS.flatMap((name) => {
    const value = vars[name];

    return value === undefined ? [] : writtenNames(name).map((key) => [key, value]);
  }));
}

/** Whether `key` is one of the runner's own variables, which a task never inherits from it: any `SELF_HOSTED_AGENT_` one, or any `KY_` one (PR5b removes). */
export function isRunnerEnv(key: string): boolean {
  return key.startsWith(ENV_PREFIX) || key.startsWith(LEGACY_ENV);
}

/** The headers between a runner (or a task) and the Worker. */
export const HEADERS = {
  /** The pairing a machine token was minted for, which the Worker names to the agent. */
  pairing: "X-Self-Hosted-Agent-Pairing",
  /** A file's name, URI-encoded, on an upload. */
  name: "X-Self-Hosted-Agent-Name",
  /** A file's caption, URI-encoded, on an upload. */
  caption: "X-Self-Hosted-Agent-Caption"
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
