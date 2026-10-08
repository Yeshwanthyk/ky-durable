#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * The live checks: `KY_URL=https://ky.<you>.workers.dev KY_TOKEN=... pnpm gate:live`.
 *
 * Opt-in, never part of `pnpm gate`: they need a deployed ky and its real
 * bindings, which the local stack replaces with fakes or leaves out. They only
 * read: no message is sent, no model is called and no task is started, so
 * running them against the real deployment is safe. One line per check,
 * PASS or FAIL; exit 1 on any FAIL.
 *
 *   login       the sign-in page answers
 *   auth        a wrong token is refused, the right one opens the app
 *   hello       the session socket says hello with ky's tools
 *   cloud       a cloud model provider is connected (Workers AI, on every deploy)
 *   vibeproxy   VibeProxy is connected: the Mac is online with it running
 *
 * `vibeproxy` fails, correctly, while the Mac is away. What a read cannot
 * prove (Browser Rendering, the real Executor, a real `claude` run, a real
 * model turn) is in FEATURES.md as live-only, with how to try it by hand.
 */
import { connect } from "./harness/client.ts";

const url = process.env.KY_URL?.replace(/\/$/, "");

const token = process.env.KY_TOKEN;

if (!url || !token) {
  console.error("usage: KY_URL=https://ky.<you>.workers.dev KY_TOKEN=... pnpm gate:live");
  process.exit(2);
}

let failed = false;

async function check(name: string, run: () => Promise<string | undefined>): Promise<void> {
  try {
    const problem = await run();

    failed ||= problem !== undefined;
    console.log(`${problem === undefined ? "PASS" : "FAIL"}  ${name.padEnd(10)}${problem ? `  ${problem}` : ""}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL  ${name.padEnd(10)}  ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check("login", async () => {
  const response = await fetch(`${url}/login`);

  return response.status === 200 ? undefined : `GET /login answered ${response.status}`;
});

await check("auth", async () => {
  const wrong = await fetch(`${url}/`, { headers: { Authorization: "Bearer not-the-token" }, redirect: "manual" });
  const right = await fetch(`${url}/`, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });

  if (wrong.status === 200) return "a wrong token opened the app";

  return right.status === 200 ? undefined : `the token was refused (${right.status})`;
});

const client = await connect(url, "", token);

try {
  await client.until("hello and settings", () =>
    ["hello", "settings"].every((type) => client.frames.some((frame) => frame.type === type))
  );
} catch {
  // Each check below reports what is missing.
}

const hello = client.frames.find((frame) => frame.type === "hello");

const tools = new Set(hello?.type === "hello" ? hello.tools.map((tool) => tool.name) : []);

await check("hello", async () => (tools.has("machine") ? undefined : "no hello with the machine tool"));

const settings = client.frames.findLast((frame) => frame.type === "settings");

const providers = settings?.type === "settings" ? settings.settings.providers : [];

await check("cloud", async () => {
  const cloud = providers.filter((provider) => provider.id !== "vibeproxy");

  if (cloud.length === 0) return "no cloud provider in settings";

  return cloud.some((provider) => provider.connected) ? undefined : `not connected: needs ${cloud[0]!.needs ?? "a key"}`;
});

await check("vibeproxy", async () => {
  const provider = providers.find((each) => each.id === "vibeproxy");

  if (!provider) return "no vibeproxy provider in settings";

  return provider.connected ? undefined : `not connected: needs ${provider.needs ?? "VibeProxy"}`;
});

client.close();

process.exit(failed ? 1 : 0);
