import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiClientMessage, PiServerMessage } from "../protocol";
import {
  agent,
  call,
  connect,
  connectExecutor,
  FACTS,
  follow,
  type Follower,
  gateStarted,
  inside,
  prompt,
  runner,
  said,
  shows,
  submit,
  tasks,
  until,
  wait
} from "./drive";
import { CONTEXT_WINDOW } from "../models";
import { PROTOCOL } from "../runner-protocol";
import { decodeNewChat, decodeSkillVersions } from "./frames";
import { FakeAccess } from "./fake-access";
import { BARE, GLM, GPT_OSS, KIMI } from "./stack";
import { ANTHROPIC_KEY } from "../../test/fakes/vendors";

/**
 * One check per server-side feature in FEATURES.md that the local stack can
 * reach, each through ky's real Worker and PiAgent on the fake Workers AI.
 */

type Frame<T extends PiServerMessage["type"]> = Extract<PiServerMessage, { type: T }>;

/** The newest frame of one type. */
/** The summary of a memory block like "0-1", or null while it is unwritten. */
async function summarized(name: string, block: string): Promise<string | null> {
  const [lo = 0, hi = 0] = block.split("-").map(Number);

  return inside(name, (_instance, state) =>
    state.storage.sql.exec<{ text: string }>("SELECT text FROM memo_tree WHERE lo = ? AND hi = ?", lo, hi + 1).toArray()[0]?.text ?? null
  );
}

function latest<T extends PiServerMessage["type"]>(client: Follower, type: T): Frame<T> | undefined {
  const frames = client.frames.filter((frame): frame is Frame<T> => frame.type === type);

  return frames.at(-1);
}

async function session(name: string, query = "", origin?: string): Promise<{ socket: WebSocket; client: Follower }> {
  const socket = await connect(name, query, origin);
  const client = follow(socket);
  await client.until(() => client.frames.some((frame) => frame.type === "events"));

  return { socket, client };
}

/** Send a command with an id and wait for its result or error. */
async function command(
  socket: WebSocket,
  client: Follower,
  message: PiClientMessage
): Promise<Frame<"result"> | Frame<"error">> {
  const id = crypto.randomUUID();
  socket.send(JSON.stringify({ ...message, id }));

  const reply = () =>
    client.frames.find(
      (frame): frame is Frame<"result"> | Frame<"error"> =>
        (frame.type === "result" || frame.type === "error") && frame.id === id
    );

  await client.until(() => reply() !== undefined);

  return reply()!;
}

describe("the tools", () => {
  it("remembers a note and recalls it", async () => {
    const name = crypto.randomUUID();
    const noted = await prompt(name, 'tool memory_note {"text":"the user likes green tea"}');
    expect(noted.text).toMatch(/^tool said: /);

    const recalled = await prompt(name, 'tool memory_recall {"regex":"green tea"}');
    expect(recalled.text).toContain("the user likes green tea");
  });

  it("writes summaries on the background model, opens them, and rewrites a forgotten one", async () => {
    const name = crypto.randomUUID();
    await prompt(name, 'tool memory_note {"text":"first memory"}');
    expect((await prompt(name, 'tool memory_note {"text":"second memory"}')).text).toBe("tool said: Saved as #1.");

    // The two notes owe a summary; the fake background model writes "first to last".
    await until(async () => (await summarized(name, "0-1")) !== null, "a summary");
    expect(await summarized(name, "0-1")).toBe("first memory to second memory");

    const zoomed = (await prompt(name, 'tool memory_zoom {"block":"0-1"}')).text;
    expect(zoomed).toContain("first memory");
    expect(zoomed).toContain("second memory");

    const forgot = (await prompt(name, 'tool memory_forget {"block":"0-1"}')).text;
    expect(forgot).toBe("tool said: Forgot 1 summary; it is rewritten in the background.");
    await until(async () => (await summarized(name, "0-1")) !== null, "the summary rewritten");
    expect(await summarized(name, "0-1")).toBe("first memory to second memory");
  });

  it("finds any message of the main chat and the side chats with chat_search", async () => {
    const name = crypto.randomUUID();
    await prompt(name, "The deploy broke on wrangler types in Lisbon");
    await prompt(name, "something in between");
    await prompt(name, "Groceries from Rainbow on Sunday");

    const search = async (args: { query: string; around?: number }) => (await prompt(name, `tool chat_search ${JSON.stringify(args)}`)).text;

    // Every word: the user's message and ky's echo of it, newest kept out of the way of the order.
    const all = await search({ query: "wrangler Lisbon" });
    expect(all).toContain("main chat user: The deploy broke on [wrangler] types in [Lisbon]");
    expect(all).toContain("main chat ky: echo: The deploy broke on [wrangler] types in [Lisbon]");
    expect(all).not.toContain("Groceries");
    expect(all).not.toContain("chat_search");
    expect(all).toMatch(/2 matches\./);

    // No message has both words: some of them, and it says so.
    const some = await search({ query: "Rainbow Lisbon" });
    expect(some).toContain("No message has all those words");
    expect(some).toContain("[Rainbow]");
    expect(some).toContain("[Lisbon]");

    // Around shows the neighbors in order.
    const near = await search({ query: "between", around: 1 });
    expect(near).toMatch(/ky: echo: The deploy broke[\s\S]*> #\d+ user: something in \[between\][\s\S]*ky: echo: something in between/);

    expect(await search({ query: "zanzibar" })).toBe("tool said: No message matches zanzibar.");
  });

  it("searches side chats by their title, and leaves subagents out", async () => {
    const name = crypto.randomUUID();
    const side = await inside(name, (instance) => instance.newChat());
    await inside(name, (instance) => instance.harness.session(side).prompt("Plan a trip to Porto"));
    await inside(name, async (instance) => {
      // A conversation that is no chat, like a subagent's.
      const { id } = await instance.harness.sessions.create();
      await instance.harness.session(String(id)).prompt("Porto from a subagent");
    });

    const found = (await prompt(name, 'tool chat_search {"query":"Porto"}')).text;
    expect(found).toMatch(/chat "[^"]*" user: Plan a trip to \[Porto\]/);
    expect(found).not.toContain("subagent");
  });

  it("tells pi a window of at most 136k tokens, so it compacts near 87k instead of near the model's 1M", async () => {
    const windows = await inside(crypto.randomUUID(), (instance) => {
      const { choice, model } = instance.models.resolve("main");

      return [instance.models.registry.getModel(choice.provider, choice.modelId)?.contextWindow, model.contextWindow] as const;
    });

    // pi reads the capped window; the model itself keeps its 1M.
    expect(windows).toEqual([CONTEXT_WINDOW, 1_048_576]);
  });

  it("writes and reads a workspace file that outlives the object", async () => {
    const name = crypto.randomUUID();
    await prompt(name, 'tool write {"path":"/workspace/notes.txt","content":"kept"}');
    await evictDurableObject(agent(name));

    const read = await prompt(name, 'tool read {"path":"/workspace/notes.txt"}');
    expect(read.text).toContain("kept");
  });

  it("runs JavaScript in the workspace with exec", async () => {
    const result = await prompt(crypto.randomUUID(), 'tool exec {"command":"export default () => 6 * 7"}');
    expect(result.text).toContain("42");
  });

  it("calls Executor over MCP", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const skills = await prompt(name, "tool executor_skills {}");
    expect(skills.text).toBe("tool said: fake executor apps: calendar (2 skills), github (3 skills)");

    const ran = await prompt(name, 'tool executor_execute {"code":"return 1"}');
    expect(ran.text).toBe("tool said: ran 1");

    const resumed = await prompt(name, 'tool executor_resume {"requestId":"approval-1"}');
    expect(resumed.text).toBe("tool said: fake executor resumed approval-1");
  });
});

describe("running turns", () => {
  it("steers a running turn with a message sent while it works", async () => {
    const name = crypto.randomUUID();
    const { socket, client } = await session(name);
    socket.send(JSON.stringify({ type: "submit", input: "gate" }));
    await gateStarted(name, 1);

    socket.send(JSON.stringify({ type: "submit", input: "also this", whenBusy: "steer" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await agent(name).release();

    await client.until(() => shows(client.view(), "echo: also this") && !client.view().running);
    socket.close();
  });

  it("stops a running turn", async () => {
    const name = crypto.randomUUID();
    const { socket, client } = await session(name);
    socket.send(JSON.stringify({ type: "submit", input: "gate" }));
    await gateStarted(name, 1);
    await client.until(() => client.view().running);

    expect(await command(socket, client, { type: "abort" })).toMatchObject({ type: "result" });
    await client.until(() => !client.view().running);
    expect(shows(client.view(), "released")).toBe(false);
    socket.close();
  });

  it("serves the deploy's version, and a fresh snapshot on resync", async () => {
    const { socket, client } = await session(crypto.randomUUID());
    expect(latest(client, "hello")?.version).toEqual(expect.any(String));

    const snapshots = () =>
      client.frames.filter((frame) => frame.type === "events" && frame.events[0]?.type === "snapshot").length;

    const before = snapshots();
    await command(socket, client, { type: "resync" });
    await client.until(() => snapshots() > before);
    socket.close();
  });
});

describe("side chats and titles", () => {
  it("starts a side chat whose title the background model rewrites from its first message", async () => {
    const name = crypto.randomUUID();
    const main = await session(name);
    const created = await command(main.socket, main.client, { type: "new-chat" });
    expect(created).toMatchObject({ type: "result", result: { session: expect.any(String) } });
    const chat = created.type === "result" ? (decodeNewChat(created.result) ?? "") : "";

    const side = await session(name, `?session=${chat}`);
    side.socket.send(JSON.stringify({ type: "submit", input: "Plan a trip to Lisbon\nwith details" }));
    await side.client.until(() => shows(side.client.view(), "echo: Plan a trip to Lisbon"));

    // The model's `Title: "Named: …"` and second line are cleaned to the bare title.
    await main.client.until(() =>
      latest(main.client, "chats")?.chats.some((row) => row.session === chat && row.title === "Named: Plan a trip to Lisbon") === true
    );

    // The main chat does not hear the side chat.
    expect(shows(main.client.view(), "Lisbon")).toBe(false);
    main.socket.close();
    side.socket.close();
  });

  it("trims a long title, and keeps the first line when the background model fails", async () => {
    const name = crypto.randomUUID();
    const main = await session(name);

    const open = async (text: string) => {
      const created = await command(main.socket, main.client, { type: "new-chat" });
      const chat = created.type === "result" ? (decodeNewChat(created.result) ?? "") : "";
      const side = await session(name, `?session=${chat}`);
      side.socket.send(JSON.stringify({ type: "submit", input: text }));
      await side.client.until(() => !side.client.view().running && side.client.view().messages.length > 1);
      side.socket.close();

      return chat;
    };

    const long = await open("a".repeat(80));
    await main.client.until(() => latest(main.client, "chats")?.chats.find((row) => row.session === long)?.title.startsWith("Named:") === true);
    const title = latest(main.client, "chats")?.chats.find((row) => row.session === long)?.title ?? "";
    expect(title).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);

    const failed = await open("no-title for this one");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(latest(main.client, "chats")?.chats.find((row) => row.session === failed)?.title).toBe("no-title for this one");
    main.socket.close();
  });

  it("archives a side chat and puts it back, keeping it across restarts", async () => {
    const name = crypto.randomUUID();
    const main = await session(name);
    const created = await command(main.socket, main.client, { type: "new-chat" });
    const chat = created.type === "result" ? (decodeNewChat(created.result) ?? "") : "";
    const row = (client: Follower) => latest(client, "chats")?.chats.find((each) => each.session === chat);
    await main.client.until(() => row(main.client) !== undefined);
    expect(row(main.client)?.archived_at).toBeNull();

    expect(await command(main.socket, main.client, { type: "archive-chat", session: chat, archived: true })).toMatchObject({
      type: "result"
    });
    await main.client.until(() => (row(main.client)?.archived_at ?? null) !== null);
    main.socket.close();

    // Archived is stored, not just sent, and the chat itself is still there to open.
    await evictDurableObject(agent(name));
    const later = await session(name);
    expect(row(later.client)?.archived_at).toEqual(expect.any(Number));
    const side = await session(name, `?session=${chat}`);
    side.socket.close();

    await command(later.socket, later.client, { type: "archive-chat", session: chat, archived: false });
    await later.client.until(() => row(later.client)?.archived_at === null);

    expect(
      await command(later.socket, later.client, { type: "archive-chat", session: "not-a-chat", archived: true })
    ).toMatchObject({ type: "error" });
    later.socket.close();
  });
});

describe("skills panel", () => {
  it("sends skills on connect and on change, and takes the user's edits, history and reverts", async () => {
    const name = crypto.randomUUID();
    const main = await session(name);
    const skill = () => latest(main.client, "skills")?.skills.find((each) => each.name === "weekly-groceries");
    expect(latest(main.client, "skills")?.skills).toEqual([]);

    await prompt(
      name,
      `tool skill_manage ${JSON.stringify({ action: "create", name: "weekly-groceries", description: "Groceries", body: "Oat milk." })}`
    );
    await main.client.until(() => skill()?.body === "Oat milk.");

    await command(main.socket, main.client, {
      type: "skill-change",
      change: { action: "edit", name: "weekly-groceries", body: "Soy milk." }
    });
    await main.client.until(() => skill()?.body === "Soy milk.");

    const history = await command(main.socket, main.client, { type: "skill-history", name: "weekly-groceries" });
    expect(history).toMatchObject({
      type: "result",
      result: [
        { action: "edit", actor: "user" },
        { action: "create", actor: "agent" }
      ]
    });
    const version = history.type === "result" ? (decodeSkillVersions(history.result)[1] ?? 0) : 0;

    await command(main.socket, main.client, { type: "skill-change", change: { action: "revert", name: "weekly-groceries", version } });
    await main.client.until(() => skill()?.body === "Oat milk.");

    await command(main.socket, main.client, { type: "skill-change", change: { action: "archive", name: "weekly-groceries" } });
    await main.client.until(() => skill()?.status === "archived");

    expect(
      await command(main.socket, main.client, { type: "skill-change", change: { action: "archive", name: "no-such-skill" } })
    ).toMatchObject({ type: "error" });
    main.socket.close();
  });
});

describe("soul panel", () => {
  it("sends SOUL.md on connect and on change, and takes the user's edits and history", async () => {
    const name = crypto.randomUUID();
    const main = await session(name);
    const soul = () => latest(main.client, "soul")?.soul;
    expect(soul()).toMatchObject({ version: 1 });
    expect(soul()?.body).toContain("# SOUL.md");

    await command(main.socket, main.client, { type: "soul-change", change: { action: "edit", body: "# SOUL.md\nBe brief." } });
    await main.client.until(() => soul()?.body === "# SOUL.md\nBe brief.");

    await prompt(name, `tool soul_edit ${JSON.stringify({ action: "patch", old: "brief", new: "kind" })}`);
    await main.client.until(() => soul()?.body === "# SOUL.md\nBe kind.");

    expect(await command(main.socket, main.client, { type: "soul-history" })).toMatchObject({
      type: "result",
      result: [
        { action: "patch", actor: "agent" },
        { action: "edit", actor: "user" },
        { action: "create", actor: "template" }
      ]
    });
    expect(
      await command(main.socket, main.client, { type: "soul-change", change: { action: "revert", version: 99 } })
    ).toMatchObject({ type: "error" });
    main.socket.close();
  });
});

describe("memory panel", () => {
  it("sends the memory on connect and on change, and searches, opens and rebuilds it", async () => {
    const name = crypto.randomUUID();
    const main = await session(name);
    const memory = () => latest(main.client, "memory")?.memory;
    expect(memory()).toEqual({ count: 0, newest: null, items: [] });

    await prompt(name, `tool memory_note ${JSON.stringify({ text: "the user drinks green tea" })}`);
    await main.client.until(() => memory()?.count === 1);
    expect(memory()?.items).toMatchObject([{ kind: "memory", id: 0, text: "the user drinks green tea" }]);

    await prompt(name, `tool memory_note ${JSON.stringify({ text: "ky shipped the soul panel" })}`);
    await until(async () => (await summarized(name, "0-1")) !== null, "a summary");
    // Two memories fit the view as written; zoom opens their block.

    expect(await command(main.socket, main.client, { type: "memory-search", query: "GREEN|soul" })).toMatchObject({
      result: { total: 2, regex: true, matches: [{ id: 1 }, { id: 0 }] }
    });
    expect(await command(main.socket, main.client, { type: "memory-zoom", block: "0-1" })).toMatchObject({
      result: [{ id: 1 }, { id: 0 }]
    });

    await command(main.socket, main.client, { type: "memory-forget", block: "0-1" });
    expect(await command(main.socket, main.client, { type: "memory-forget", block: "0-1" })).toMatchObject({
      type: "error",
      message: "No summary at 0-1."
    });
    main.socket.close();
  });
});

describe("settings", () => {
  it("stores a purpose's model across restarts and refuses one that does not exist", async () => {
    const name = crypto.randomUUID();
    const { socket, client } = await session(name);

    expect(latest(client, "settings")?.settings.purposes).toMatchObject({
      main: { provider: "workers-ai", modelId: GLM },
      worker: { provider: "workers-ai", modelId: GLM },
      background: { provider: "workers-ai", modelId: GLM, thinkingLevel: "off" },
      fallback: { provider: "workers-ai", modelId: KIMI }
    });

    const providers = latest(client, "settings")?.settings.providers ?? [];
    expect(providers.find((each) => each.id === "vibeproxy")?.connected).toBe(false);

    const refused = await command(socket, client, {
      type: "set-model",
      purpose: "main",
      choice: { provider: "workers-ai", modelId: "missing", thinkingLevel: "off" }
    });

    expect(refused).toMatchObject({ type: "error", message: "workers-ai/missing is not available." });

    await command(socket, client, {
      type: "set-model",
      purpose: "background",
      choice: { provider: "workers-ai", modelId: GPT_OSS, thinkingLevel: "off" }
    });

    socket.close();
    await evictDurableObject(agent(name));
    const later = await session(name);
    expect(latest(later.client, "settings")?.settings.purposes.background).toMatchObject({ modelId: GPT_OSS });
    later.socket.close();
  });
});

describe("API keys in Settings", () => {
  it("tests and saves a vendor's key, never sends it back, and falls back once it is removed", async () => {
    const name = `${BARE}${crypto.randomUUID()}`;
    const { socket, client } = await session(name);
    const settings = () => latest(client, "settings")?.settings;
    const lastModel = async () => (await inside(name, (instance) => instance.boundary.calls.at(-1)?.model));

    expect(settings()?.vendors.map((vendor) => vendor.name)).toEqual(["Anthropic", "OpenAI", "OpenCode Go"]);
    expect(await command(socket, client, { type: "add-key", vendor: "anthropic", key: "sk-ant-api03-wrong" })).toMatchObject({
      type: "result",
      result: { refused: expect.stringMatching(/^Anthropic refused the key: 401/) }
    });

    expect(await command(socket, client, { type: "add-key", vendor: "anthropic", key: ANTHROPIC_KEY })).toEqual(
      expect.objectContaining({ type: "result", result: {} })
    );
    await client.until(() => settings()?.purposes.main?.provider === "anthropic");
    expect(settings()?.providers.find((each) => each.id === "anthropic")).toMatchObject({ kind: "api-key", connected: true });
    expect(settings()?.vendors.map((vendor) => vendor.id)).toEqual(["openai", "opencode-go"]);
    // The chats move to Claude.
    expect((await prompt(name, "hello")).text).toBe("echo: hello");
    expect(await lastModel()).toBe("claude-opus-5-5");

    await command(socket, client, { type: "remove-key", provider: "anthropic" });
    await client.until(() => settings()?.purposes.main?.provider === "workers-ai");
    expect(settings()?.providers.map((each) => each.id)).toEqual(["workers-ai"]);
    expect((await prompt(name, "again")).text).toBe("echo: again");
    expect(await lastModel()).toBe(GLM);

    expect(JSON.stringify(client.frames)).not.toContain(ANTHROPIC_KEY);
    socket.close();
  });
});

describe("a deploy's own setup", () => {
  it("shows VibeProxy as not set up on a deploy without it, and runs on Workers AI without Executor until Settings connects it", async () => {
    const name = `${BARE}${crypto.randomUUID()}`;
    const { socket, client } = await session(name);

    expect(latest(client, "settings")?.settings.providers.map((each) => each.id)).toEqual(["workers-ai"]);
    expect(latest(client, "setup")?.setup).toEqual({
      repo: null,
      url: null,
      missing: [
        {
          id: "vibeproxy",
          name: "Claude via VibeProxy",
          needs: "a paired machine whose runner shares port 8317 (KY_RUNNER_PORTS=8317), or the VIBEPROXY binding, VIBEPROXY_ORIGIN, and the VIBEPROXY_KEY secret"
        }
      ]
    });

    const hello = latest(client, "hello");
    expect(hello?.tools.some((tool) => tool.name.startsWith("executor_"))).toBe(false);

    expect((await prompt(name, "hello")).text).toBe("echo: hello");
    const [main] = await inside(name, (instance) => instance.boundary.calls.map((each) => each.system));
    expect(main).not.toContain("Executor");
    socket.close();
  });

  it("falls back to the defaults when a saved model's provider is no longer set up", async () => {
    const name = `${BARE}${crypto.randomUUID()}`;
    const stale = JSON.stringify({ provider: "vibeproxy", modelId: "claude-opus-5-5", thinkingLevel: "medium" });

    await inside(name, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO ky_purposes (purpose, value) VALUES ('main', ?)", stale);
    });
    await evictDurableObject(agent(name));

    const { socket, client } = await session(name);
    expect(latest(client, "settings")?.settings.purposes.main).toEqual({
      provider: "workers-ai",
      modelId: GLM,
      thinkingLevel: "off"
    });
    expect((await prompt(name, "hello")).text).toBe("echo: hello");
    socket.close();
  });

  it("offers self-edits in the main prompt once Settings has ky's repo, at the address of the page that set it", async () => {
    const name = crypto.randomUUID();
    await connectExecutor(name);
    const { socket, client } = await session(name);
    const systems = () => inside(name, (instance) => instance.boundary.calls.map((each) => each.system));

    await prompt(name, "hello");
    const [before] = await systems();
    expect(before).toContain("The user's apps and accounts are behind Executor.");
    expect(before).not.toContain("Changing yourself");
    expect(before).not.toMatch(/\bMac\b|Yeshwanthyk|ky-durable|workers\.dev/);

    expect(await command(socket, client, { type: "set-repo", repo: "not a repo" })).toMatchObject({
      type: "result",
      result: { refused: '"not a repo" is not a GitHub repo; write it as owner/name.' }
    });
    expect(latest(client, "setup")?.setup).toMatchObject({ repo: null, url: null });

    await command(socket, client, { type: "set-repo", repo: " test-owner/test-repo " });
    expect(latest(client, "setup")?.setup).toMatchObject({ repo: "test-owner/test-repo", url: "https://ky.test" });

    await prompt(name, "again");
    const after = (await systems()).at(-1);
    expect(after).toContain("your own code is the GitHub repo test-owner/test-repo.");
    expect(after).toContain("run one machine task, on a machine that has the repo,");
    expect(after).toContain("1. cd to its working copy of test-owner/test-repo (gh repo clone test-owner/test-repo if it has none).");
    expect(after).toContain("4. Check that https://ky.test/login answers 200.");
    expect(after).not.toMatch(/\bMac\b/);

    // Only setting the repo moves ky's address: a page opened elsewhere leaves it, and setting the repo there takes it.
    const elsewhere = await session(name, "", "https://preview.ky.test");
    expect(latest(elsewhere.client, "setup")?.setup.url).toBe("https://ky.test");
    await command(elsewhere.socket, elsewhere.client, { type: "set-repo", repo: "test-owner/test-repo" });
    expect(latest(client, "setup")?.setup.url).toBe("https://preview.ky.test");

    await prompt(name, "moved");
    expect((await systems()).at(-1)).toContain("4. Check that https://preview.ky.test/login answers 200.");

    await command(socket, client, { type: "set-repo", repo: "" });
    expect(latest(client, "setup")?.setup.repo).toBeNull();
    elsewhere.socket.close();
    socket.close();
  });
});

describe("machine tasks", () => {
  it("runs a task, shows its session and steps, takes a follow-up, and reports its result and spend", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);
    const { socket, client } = await session(name);

    await prompt(name, "machine build it");
    const run = await mac.run();
    expect(run).toMatchObject({ type: "run", prompt: "build it", session: null });

    mac.send({ type: "session", task: run.task, turn: run.turn, session: "claude-session-1" });
    mac.send({ type: "step", task: run.task, turn: run.turn, text: "Running pnpm build" });
    mac.send({ type: "step", task: run.task, turn: run.turn, text: "Editing tasks.ts" });
    const row = () => latest(client, "tasks")?.tasks.find((task) => task.id === run.task);
    await client.until(() => row()?.steps.at(-1)?.text === "Editing tasks.ts");
    expect(row()).toMatchObject({ status: "working", source: "chat", finished_at: null, turns: null });
    expect(row()?.steps.map((step) => step.text)).toEqual(["Running pnpm build", "Editing tasks.ts"]);
    expect(row()?.started_at).toBeGreaterThan(0);

    await prompt(name, `tool machine {"action":"send","task":"${run.task}","message":"also test it"}`);
    const followUp = await mac.run();
    expect(followUp).toMatchObject({ type: "run", task: run.task, prompt: "also test it", session: "claude-session-1" });

    mac.send({
      type: "result",
      task: run.task,
      turn: followUp.turn,
      ok: true,
      text: "built and tested",
      session: "claude-session-1",
      agent: "claude",
      turns: 7,
      costUsd: 0.25
    });
    await said(name, `build it" finished`);
    await client.until(() => row()?.status === "done");
    expect(row()).toMatchObject({ summary: "built and tested", turns: 7, cost_usd: 0.25 });
    expect(row()?.finished_at).toBeGreaterThanOrEqual(row()?.started_at ?? Infinity);
    await client.until(() => latest(client, "tasks")?.tasks.find((task) => task.id === run.task)?.summary.startsWith("Named:") === true);
    expect(latest(client, "tasks")?.machines).toMatchObject([{ name: "mac", online: true }]);

    socket.close();
    mac.socket.close();
  });

  it("withdraws a task the runner has not picked up, and sends a stop to one it has", async () => {
    const name = crypto.randomUUID();

    // No runner yet: the task waits in the inbox.
    await prompt(name, "machine first");
    const [queued] = await tasks(name);
    expect(queued).toMatchObject({ status: "queued" });

    const { socket, client } = await session(name);
    const first = latest(client, "tasks")?.tasks[0]?.id ?? "";
    await command(socket, client, { type: "stop-task", task: first });
    await said(name, "Stopped before it started.");

    const mac = await runner(name);
    await prompt(name, "machine second");
    const run = await mac.run();
    mac.send({ type: "session", task: run.task, turn: run.turn, session: "s2" });
    await client.until(() => latest(client, "tasks")?.tasks.find((task) => task.id === run.task)?.status === "working");

    await command(socket, client, { type: "stop-all" });
    expect(await mac.next()).toMatchObject({ type: "stop", task: run.task });
    socket.close();
    mac.socket.close();
  });

  it("marks a working task interrupted when its runner restarts without it", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);
    await prompt(name, "machine long job");
    const run = await mac.run();
    mac.send({ type: "session", task: run.task, turn: run.turn, session: "s3" });
    mac.socket.close();

    const restarted = await runner(name);
    await said(name, "Interrupted: the runner restarted.");
    expect(await tasks(name)).toEqual([{ kind: "machine", worker: "mac", status: "failed" }]);
    restarted.socket.close();
  });

  it("lets the user choose which machines take work, and tells the agent what each one is", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);
    const { socket, client } = await session(name);
    const machine = (who: string) => latest(client, "tasks")?.machines.find((m) => m.name === who);

    // The runner says what it is; the user sees it, and so does the agent.
    mac.send({
      type: "hello",
      protocol: PROTOCOL,
      version: "test",
      active: [],
      facts: { ...FACTS, chrome: true, repos: [{ name: "ky", remote: "https://github.com/me/ky.git" }] }
    });
    await client.until(() => machine("mac")?.facts?.os === "darwin");
    expect(machine("mac")).toMatchObject({ state: "on", note: "" });

    expect(await command(socket, client, { type: "set-machine", machine: "mac", note: "  logins and Chrome  " })).toMatchObject({ type: "result" });
    await client.until(() => machine("mac")?.note === "logins and Chrome");
    const listed = (await prompt(name, `tool machine {"action":"list"}`)).text;
    expect(listed).toContain("mac: on, online, 0 running or queued, macOS, Chrome with the user's logins");
    expect(listed).toContain("the user says: logins and Chrome");
    expect(listed).toContain("repos: ky (https://github.com/me/ky.git)");

    // With two machines on and online, the agent has to choose.
    const box = await runner(name, "box");
    await client.until(() => machine("box")?.online === true);
    box.send({
      type: "hello",
      protocol: PROTOCOL,
      version: "test",
      active: [],
      facts: { ...FACTS, agents: { claude: { installed: false, signedIn: false }, codex: { installed: true, signedIn: true } } }
    });
    await client.until(() => machine("box")?.facts?.agents.claude.installed === false);
    expect((await prompt(name, `tool machine {"action":"list"}`)).text).toContain("box: on, online, 0 running or queued, macOS, no logged-in browser, runs Codex");
    expect((await prompt(name, `tool machine {"action":"run","prompt":"build it"}`)).text).toContain("Name the machine for this task.");

    // A paused machine takes no new task; the agent hears where else it can go.
    await command(socket, client, { type: "set-machine", machine: "mac", state: "paused" });
    await client.until(() => machine("mac")?.state === "paused");
    expect((await prompt(name, "machine build it")).text).toContain("mac is paused: the user is not letting it take new tasks. On and online: box");
    // Only box is on and online now, so it is chosen, and runs it as the agent it has.
    expect((await prompt(name, `tool machine {"action":"run","prompt":"build it"}`)).text).toContain("on box as Codex.");
    const built = await box.next();
    expect(built).toMatchObject({ type: "run", prompt: "build it", agent: "codex" });

    // A task queued for an offline machine moves before it starts, to one that runs its agent; one that ran stays.
    expect((await prompt(name, "machine@away later")).text).toContain("it starts when one does). On and online: box");
    const queued = (await tasks(name)).length;
    const [waiting] = await inside(name, (instance) => instance.feed.open("machine", "away"));
    expect((await prompt(name, `tool machine {"action":"move","task":"${waiting!.id}","machine":"box"}`)).text).toContain(
      `box cannot run Claude Code: it is not installed there. ${waiting!.id} runs as Claude Code, so it stays.`
    );
    expect((await prompt(name, `tool machine {"action":"move","task":"${built.task}","machine":"mac"}`)).text).toContain("mac is paused");
    await command(socket, client, { type: "set-machine", machine: "mac", state: "on" });
    expect((await prompt(name, `tool machine {"action":"move","task":"${waiting!.id}","machine":"mac"}`)).text).toContain(`Moved ${waiting!.id} to mac.`);
    expect(await mac.next()).toMatchObject({ type: "run", task: waiting!.id, prompt: "later", agent: "claude" });
    expect(await tasks(name)).toHaveLength(queued);
    expect((await prompt(name, `tool machine {"action":"move","task":"${built.task}","machine":"mac"}`)).text).toContain("its session lives there, so it stays");

    // The agent sets a machine when the user asks; an off machine takes no follow-up.
    expect((await prompt(name, `tool machine {"action":"set","machine":"box","state":"off"}`)).text).toContain("Set. box: off");
    expect((await prompt(name, `tool machine {"action":"send","task":"${built.task}","message":"more"}`)).text).toContain("box is off");
    expect(await command(socket, client, { type: "set-machine", machine: "nowhere", state: "off" })).toMatchObject({ type: "error", message: "No machine nowhere." });

    socket.close();
    mac.socket.close();
    box.socket.close();
  });

  it("runs a task as the agent asked for, else the machine's own, and its follow-ups as the same one", async () => {
    const name = crypto.randomUUID();
    const mac = await runner(name);
    const agentOf = (id: string) => inside(name, (instance) => instance.feed.get(id)?.agent);

    // Claude Code first, when the machine runs it.
    expect((await prompt(name, "machine build it")).text).toMatch(/^tool said: Started task \S+ on mac as Claude Code\.$/);
    const building = await mac.next();
    expect(building).toMatchObject({ type: "run", prompt: "build it", agent: "claude" });

    // An agent the machine cannot run is refused before anything is queued.
    const asCodex = `tool machine {"action":"run","machine":"mac","agent":"codex","prompt":"review it"}`;
    expect((await prompt(name, asCodex)).text).toContain("mac cannot run Codex: it is not installed there.");
    const before = (await tasks(name)).length;

    // Codex installed, by its next hello, and signed out as last asked: the user may have signed in just now, so it is not refused.
    const signedOut = { ...FACTS, agents: { ...FACTS.agents, codex: { installed: true, signedIn: false } } };
    mac.send({ type: "hello", protocol: PROTOCOL, version: "test", active: [building.task], facts: signedOut });
    await until(async () => (await inside(name, (instance) => instance.machines.machine("mac")?.facts?.agents.codex.installed)) === true, "codex installed");
    expect((await prompt(name, `tool machine {"action":"list"}`)).text).toContain("mac: on, online, 1 running or queued, macOS, no logged-in browser, runs Claude Code, Codex not signed in");
    expect((await prompt(name, asCodex)).text).toContain("on mac as Codex.");
    const reviewing = await mac.next();
    expect(reviewing).toMatchObject({ type: "run", prompt: "review it", agent: "codex", turn: 1 });
    expect(await tasks(name)).toHaveLength(before + 1);
    expect(await agentOf(reviewing.task)).toBe("codex");
    expect((await prompt(name, `tool machine {"action":"list"}`)).text).toContain(`${reviewing.task} [queued] Codex: `);

    // A follow-up goes to the task's own agent, whatever the machine would pick now.
    mac.send({ type: "session", task: reviewing.task, turn: 1, session: "thread-1" });
    await until(async () => (await tasks(name)).some((task) => task.status === "working"), "the Codex task working");
    expect((await prompt(name, `tool machine {"action":"send","task":"${reviewing.task}","message":"and the tests"}`)).text).toContain(
      `Queued for ${reviewing.task}: Codex takes it once its turn ends.`
    );
    expect(await mac.next()).toMatchObject({ type: "run", task: reviewing.task, turn: 2, prompt: "and the tests", session: "thread-1", agent: "codex" });
    mac.socket.close();
  });

  it("shares a machine task's file, and serves it whole and by range", async () => {
    // Uploads go to the user's one agent, "me".
    const mac = await runner("me");
    await prompt("me", "machine take a screenshot");
    const run = await mac.run();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

    const upload = (task: string, type = "image/png", token = run.taskToken) =>
      call(`/api/files?task=${task}`, {
        method: "PUT",
        body: png,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": type,
          "Content-Length": String(png.byteLength),
          "X-Ky-Name": "shot.png",
          "X-Ky-Caption": "the page"
        }
      });

    expect((await upload(run.task, "image/svg+xml")).status).toBe(415);
    // Only the task's own token: not for another task, and not the user's sign-in, which every call here carries.
    expect((await upload("not-a-task")).status).toBe(401);
    expect((await upload(run.task, "image/png", await new FakeAccess().sign())).status).toBe(401);

    const uploaded = await upload(run.task);
    expect(uploaded.status).toBe(200);
    const { url } = await uploaded.json<{ id: string; url: string }>();

    const whole = await call(url);
    expect(whole.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(png);

    const part = await call(url, { headers: { Range: "bytes=8-" } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(png.slice(8));

    const { client, socket } = await session("me");
    expect(latest(client, "tasks")?.files.find((file) => file.task === run.task)).toMatchObject({ name: "shot.png", caption: "the page" });
    socket.close();
    mac.socket.close();
  });

  it("shares a task's diff, and sends the user's comments on it to the task", async () => {
    const mac = await runner("me");
    await prompt("me", "machine fix the bug");
    const run = await mac.run();
    mac.send({ type: "session", task: run.task, turn: run.turn, session: "s-diff" });
    const patch = new TextEncoder().encode("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n");

    const upload = (size: number) =>
      call(`/api/files?task=${run.task}`, {
        method: "PUT",
        body: size === patch.byteLength ? patch : new Uint8Array(size),
        headers: { Authorization: `Bearer ${run.taskToken}`, "Content-Type": "text/x-diff", "Content-Length": String(size), "X-Ky-Name": "ky.diff", "X-Ky-Caption": encodeURIComponent("ky · fix") }
      });

    expect((await upload(2 * 1024 * 1024 + 1)).status).toBe(413);
    const uploaded = await upload(patch.byteLength);
    expect(uploaded.status).toBe(200);
    const served = await call((await uploaded.json<{ url: string }>()).url);
    expect(served.headers.get("Content-Type")).toBe("text/x-diff");
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await served.text()).toBe(new TextDecoder().decode(patch));

    const { client, socket } = await session("me");
    expect(latest(client, "tasks")?.files.find((file) => file.task === run.task)).toMatchObject({ type: "text/x-diff", caption: "ky · fix" });

    expect(await command(socket, client, { type: "send-task", task: run.task, message: "a.ts:1\n> b\nUse c." })).toMatchObject({ type: "result" });
    expect(await mac.next()).toMatchObject({ type: "run", task: run.task, turn: 2, prompt: "a.ts:1\n> b\nUse c.", session: "s-diff" });
    expect(await command(socket, client, { type: "send-task", task: "not-a-task", message: "hi" })).toMatchObject({ type: "error" });
    socket.close();
    mac.socket.close();
  });
});

describe("subagents", () => {
  it("stops a subagent's work from the task list", async () => {
    const name = crypto.randomUUID();
    const { socket, client } = await session(name);
    await prompt(name, "spawn worker gate");
    await gateStarted(name, 1);

    const row = latest(client, "tasks")?.tasks.find((task) => task.kind === "cloud");
    await command(socket, client, { type: "stop-task", task: row?.id ?? "" });
    await client.until(() => latest(client, "tasks")?.tasks.find((task) => task.kind === "cloud")?.status === "stopped");
    socket.close();
  });

  it("shows a subagent's tool steps, turns, and how long it took", async () => {
    const name = crypto.randomUUID();
    const { socket, client } = await session(name);
    await prompt(name, "spawn worker multiply 6");

    const row = () => latest(client, "tasks")?.tasks.find((task) => task.kind === "cloud");
    await client.until(() => row()?.status === "done");
    expect(row()?.steps.map((step) => step.text)).toEqual(["multiply"]);
    expect(row()).toMatchObject({ source: "chat", turns: 2 });
    expect(row()?.cost_usd).toBeGreaterThanOrEqual(0);
    expect(row()?.finished_at).toBeGreaterThanOrEqual(row()?.started_at ?? Infinity);
    socket.close();
  });

  it("waits for a whole run before answering a message sent as a follow-up", async () => {
    const name = crypto.randomUUID();
    const busy = await submit(name, "gate");
    await gateStarted(name, 1);
    const later = await submit(name, "after");
    await agent(name).release();

    expect((await wait(name, busy.operationId)).text).toBe("tool said: released after 1 runs");
    expect((await wait(name, later.operationId)).text).toBe("echo: after");
  });
});
