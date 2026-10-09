#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * The live checks: `KY_URL=https://ky.<you>.workers.dev KY_TOKEN=... pnpm gate:live`.
 *
 * Opt-in, never part of `pnpm gate`: they need a deployed ky and its real
 * bindings, which the local stack replaces with fakes or leaves out. All but
 * `cloud` only read. `cloud` makes one real completion: it starts a side chat,
 * waits for the background model to title it, then stops the chat's turn and
 * archives it. Nothing else is sent and no task is started, so running them
 * against the real deployment is safe. One line per check, PASS or FAIL; exit
 * 1 on any FAIL.
 *
 *   login       the sign-in page answers
 *   auth        a wrong token is refused, the right one opens the app
 *   hello       the session socket says hello with ky's tools
 *   cloud       a cloud model answers: the background model (Workers AI, on
 *               every deploy) titles a new side chat from its first message
 *   vibeproxy   VibeProxy is connected: the Mac is online with it running
 *
 * `vibeproxy` fails, correctly, while the Mac is away. What a read cannot
 * prove (Browser Rendering, the real Executor, a real `claude` run, a real
 * main-agent turn) is in FEATURES.md as live-only, with how to try it by hand.
 */
import { decodeNewChat } from "../src/tests/frames.ts";
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

  if (!cloud.some((provider) => provider.connected)) return `not connected: needs ${cloud[0]!.needs ?? "a key"}`;

  const created = await client.command({ type: "new-chat" });
  const session = decodeNewChat(created.result);

  if (!session) return "new-chat gave no session";

  // Short enough that the list shows it whole until it is renamed.
  const first = "plan a long weekend in lisbon with two kids in may";
  const side = await connect(url, `?session=${session}`, token);
  const title = () => client.frames.findLast((frame) => frame.type === "chats")?.chats.find((row) => row.session === session)?.title;
  // A new chat's row has no title; its first message titles it, until the background model's title replaces that.
  const named = () => ![undefined, "", first].includes(title());

  try {
    side.send({ type: "submit", input: first });
    await client.until("the background model's title", named, 60_000).catch(() => undefined);
  } finally {
    side.send({ type: "abort" });
    side.close();
    await client.command({ type: "archive-chat", session, archived: true });
  }

  return named() ? undefined : `the side chat's title stayed "${title() ?? "(none)"}": the background model did not answer`;
});

await check("vibeproxy", async () => {
  const provider = providers.find((each) => each.id === "vibeproxy");

  if (!provider) return "no vibeproxy provider in settings";

  return provider.connected ? undefined : `not connected: needs ${provider.needs ?? "VibeProxy"}`;
});

client.close();

process.exit(failed ? 1 : 0);
