#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * The live checks: `KY_URL=https://ky.<you>.workers.dev pnpm gate:live`.
 *
 * Opt-in, never part of `pnpm gate`: they need a deployed ky and its real
 * bindings, which the local stack replaces with fakes or leaves out. All but
 * `cloud` only read. `cloud` starts a side chat, sends it one message and
 * aborts that turn as soon as the submit is accepted, then waits for the
 * background model's title and archives the chat. It calls models twice at
 * most: one title call, and at most one main-model request, aborted. No tool
 * runs and no task is started, so running them against the real deployment
 * is safe. One line per check, PASS or FAIL; exit 1 on any FAIL. They sign
 * in as the owner with `cloudflared access token`; run
 * `cloudflared access login <KY_URL>` once first.
 *
 *   access      signed out, and with only a forged email header, the app is
 *               refused; with the owner's Access token it opens
 *   bypass      the manifest loads signed out, and a runner path reaches the
 *               Worker's own token check
 *   hello       the session socket says hello with ky's tools
 *   cloud       a cloud model answers: the background model (Workers AI, on
 *               every deploy) titles a new side chat from its first message
 *   vibeproxy   VibeProxy is connected: a computer that shares it is online,
 *               or the tunnel answers
 *
 * `vibeproxy` fails, correctly, while that computer is away. What a read cannot
 * prove (Browser Rendering, the real Executor, a real `claude` run, a real
 * main-agent turn) is in FEATURES.md as live-only, with how to try it by hand.
 */
import { spawnSync } from "node:child_process";
import { decodeNewChat } from "../src/tests/frames.ts";
import { connect } from "./harness/client.ts";

const url = process.env.KY_URL?.replace(/\/$/, "");

if (!url) {
  console.error("usage: KY_URL=https://ky.<you>.workers.dev pnpm gate:live");
  process.exit(2);
}

const login = spawnSync("cloudflared", ["access", "token", `-app=${url}`], { encoding: "utf8" });

const token = login.status === 0 ? login.stdout.trim() : "";

if (!token) {
  console.error(`No Access token for ${url}: run \`cloudflared access login ${url}\`, then try again.\n${login.stderr ?? ""}`);
  process.exit(2);
}

/** How Access takes a `cloudflared` token in place of the browser's cookie. */
const signedIn = { "cf-access-token": token };

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

await check("access", async () => {
  const get = (headers: Record<string, string>) => fetch(`${url}/`, { headers, redirect: "manual" });

  if ((await get({})).status === 200) return "the app opened signed out";

  if ((await get({ "Cf-Access-Authenticated-User-Email": "owner@example.com" })).status === 200) return "a forged email header opened the app";
  const owner = await get(signedIn);

  return owner.status === 200 ? undefined : `the owner's Access token was refused (${owner.status})`;
});

await check("bypass", async () => {
  const manifest = await fetch(`${url}/manifest.webmanifest`, { redirect: "manual" });

  if (manifest.status !== 200) return `the manifest answered ${manifest.status} signed out`;
  const runner = await fetch(`${url}/runner/gate-live`, { redirect: "manual" });

  return runner.status === 401 ? undefined : `a runner path answered ${runner.status}, not the Worker's 401`;
});

const client = await connect(url, "", signedIn);

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

/** Why a new side chat whose first message is `first` was not renamed by the background model; it is archived after. */
async function unrenamed(first: string): Promise<string | undefined> {
  const session = decodeNewChat((await client.command({ type: "new-chat" })).result);

  if (!session) return "new-chat gave no session";

  const side = await connect(url!, `?session=${session}`, signedIn);
  const title = () => client.frames.findLast((frame) => frame.type === "chats")?.chats.find((row) => row.session === session)?.title;
  // A new chat's row has no title; its first message titles it, until the background model's title replaces that.
  const named = () => ![undefined, "", first].includes(title());

  try {
    // Titling runs apart from the turn (server.ts #nameThings), so the turn is stopped before it can call a tool.
    await side.command({ type: "submit", input: first });
    await side.command({ type: "abort" });
    await client.until("the background model's title", named, 60_000).catch(() => undefined);
  } finally {
    side.close();
    await client.command({ type: "archive-chat", session, archived: true });
  }

  return named() ? undefined : `the side chat's title stayed "${title() ?? "(none)"}": the background model did not answer`;
}

await check("cloud", async () => {
  const cloud = providers.filter((provider) => provider.id !== "vibeproxy");

  if (cloud.length === 0) return "no cloud provider in settings";

  if (!cloud.some((provider) => provider.connected)) return `not connected: needs ${cloud[0]!.needs ?? "a key"}`;

  // Short enough that the list shows it whole until it is renamed.
  return unrenamed("plan a long weekend in lisbon with two kids in may");
});

await check("vibeproxy", async () => {
  const provider = providers.find((each) => each.id === "vibeproxy");

  if (!provider) return "no vibeproxy provider in settings";

  return provider.connected ? undefined : `not connected: needs ${provider.needs ?? "VibeProxy"}`;
});

client.close();

process.exit(failed ? 1 : 0);
