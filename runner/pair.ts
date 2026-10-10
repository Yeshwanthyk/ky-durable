#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Pair this machine with ky, once, before runner/ky-runner.ts runs on it:
 *
 *   node runner/pair.ts https://ky.<you>.workers.dev <code>
 *
 * The code comes from ky's Settings, Machines, Add a machine. The machine
 * token ky answers with is kept in KY_RUNNER_TOKEN_FILE (default
 * ~/.config/ky/runner-token), readable by this user only. KY_MACHINE names
 * the machine (default: this host's name), the same for the runner.
 *
 * Until `ky runner add` exists, the facts sent are only what needs no
 * runner settings; the runner's first hello says the rest.
 */
import type { MachineFacts } from "../src/runner-protocol.ts";
import { machineName, tokenFile, writeToken } from "./identity.ts";

const [url, code] = process.argv.slice(2);

if (!url || !code) {
  console.error("usage: node runner/pair.ts <ky url> <code>");
  process.exit(1);
}

const facts: MachineFacts = {
  os: process.platform,
  chrome: false,
  repos: [],
  agents: { claude: { installed: false, signedIn: false }, codex: { installed: false, signedIn: false } },
  ports: [],
  kind: "computer"
};

const response = await fetch(`${url.replace(/\/$/, "")}/api/runners/pair`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code, name: machineName(), facts })
});

if (!response.ok) {
  console.error(`ky refused to pair (HTTP ${response.status}): ${(await response.text()).trim()}`);
  process.exit(1);
}

// SAFETY: ky's /api/runners/pair answers { machine, token } with a 200.
const { machine, token } = (await response.json()) as { machine: string; token: string };

const file = tokenFile();

writeToken(file, token);

console.log(`Paired as ${machine}. Its token is in ${file}. Start the runner: KY_URL=${url} node runner/ky-runner.ts`);
