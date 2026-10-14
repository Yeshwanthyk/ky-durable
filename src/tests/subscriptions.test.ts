import { env } from "cloudflare:workers";
import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type MachineFacts, PROTOCOL } from "../machines/contract";
import { SUBSCRIPTION } from "../vault";
import { connect, FACTS, follow, inside, prompt, runner, until } from "./drive";
import type { Vault as TestVault } from "./stack";

/**
 * Settings › Subscriptions and their handoff (src/subscriptions.ts,
 * src/machines/machines.ts): the user's Claude token and ChatGPT login, kept in the
 * one Vault, handed to a machine's task only when the machine isn't signed
 * in or uses ky's login, and renewed for a Codex task before it expires.
 * The Vault is shared by every agent, so each test removes what it set up.
 */

// SAFETY: src/tests/wrangler.jsonc binds Vault to the test stack's subclass.
const vault = () => (env.Vault as DurableObjectNamespace<TestVault>).getByName("owner");

/** A Mac with both CLIs and neither signed in. */
const SIGNED_OUT: MachineFacts = {
  ...FACTS,
  agents: { claude: { installed: true, signedIn: false }, codex: { installed: true, signedIn: false } }
};

/** A Mac with both CLIs signed in. */
const SIGNED_IN: MachineFacts = {
  ...FACTS,
  agents: { claude: { installed: true, signedIn: true }, codex: { installed: true, signedIn: true } }
};

const claudeToken = () => `sk-ant-oat01-test-${crypto.randomUUID()}`;

/** Every table of the agent `name`, and its key-value storage, as text. */
function stored(name: string): Promise<string> {
  return inside(name, async (_instance, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'")
      .toArray();

    const rows = tables.map(({ name: table }) => JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()));

    return [...rows, JSON.stringify([...(await state.storage.list()).entries()])].join("\n");
  });
}

const codexRun = (prompt: string) => `tool machine ${JSON.stringify({ action: "run", machine: "mac", agent: "codex", prompt })}`;

describe("Settings › Subscriptions", () => {
  it("keeps a Claude token, refuses what isn't one, and shows only its status", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    const raw: string[] = [];
    socket.addEventListener("message", (event) => {
      raw.push(String(event.data));
    });
    const token = claudeToken();

    socket.send(JSON.stringify({ type: "set-claude", id: "bad", token: "sk-ant-api03-not-a-subscription" }));
    socket.send(JSON.stringify({ type: "set-claude", id: "good", token: `  ${token}\n` }));
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === "good"));

    expect(client.frames.find((frame) => frame.type === "result" && frame.id === "bad")).toMatchObject({
      result: { refused: "That's an Anthropic API key; it goes in Settings › Providers. Here, paste what `claude setup-token` prints." }
    });
    expect(client.frames.find((frame) => frame.type === "result" && frame.id === "good")).toMatchObject({ result: {} });
    await client.until(() =>
      client.frames.some((frame) => frame.type === "subscriptions" && frame.subscriptions.some((each) => each.kind === "claude" && each.connected))
    );
    expect(client.frames.findLast((frame) => frame.type === "subscriptions")).toMatchObject({
      subscriptions: [
        { kind: "claude", connected: true, expiresAt: expect.any(Number) },
        { kind: "chatgpt", connected: false },
        { kind: "github", connected: false }
      ]
    });
    expect(raw.some((frame) => frame.includes(token))).toBe(false);

    socket.send(JSON.stringify({ type: "remove-subscription", id: "remove", kind: "claude" }));
    await client.until(() => {
      const latest = client.frames.findLast((frame) => frame.type === "subscriptions");

      return latest?.type === "subscriptions" && latest.subscriptions.every((each) => !each.connected);
    });
    expect(await vault().sessionCreds("claude")).toBeNull();
    socket.close();
  });

  it("joins a Claude token the terminal wrapped, and says what is wrong with a paste without repeating it", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    const result = (id: string) => client.frames.find((frame) => frame.type === "result" && frame.id === id);
    const token = claudeToken();
    const set = (id: string, paste: string) => socket.send(JSON.stringify({ type: "set-claude", id, token: paste }));

    set("empty", " \n ");
    set("other", "not-a-token-at-all");
    set("short", "sk-ant-oat01-\n");
    set("odd", `${token}!@#`);
    await client.until(() => result("odd") !== undefined);
    expect(result("empty")).toMatchObject({ result: { refused: "Paste what `claude setup-token` prints." } });
    expect(result("other")).toMatchObject({ result: { refused: "A Claude subscription token starts with sk-ant-oat. Paste what `claude setup-token` prints." } });
    expect(result("short")).toMatchObject({ result: { refused: "That token is cut short. Paste what `claude setup-token` prints." } });
    expect(result("odd")).toMatchObject({ result: { refused: expect.stringContaining("characters a Claude subscription token can't have") } });
    expect(JSON.stringify(client.frames)).not.toContain("not-a-token-at-all");
    expect(JSON.stringify(client.frames)).not.toContain(token);

    for (const [id, paste] of [
      ["newline", `${token.slice(0, 20)}\n${token.slice(20)}\n`],
      ["spaces", `  ${token.slice(0, 12)} ${token.slice(12, 30)}   ${token.slice(30)}`]
    ] as const) {
      set(id, paste);
      await client.until(() => result(id) !== undefined);
      expect(result(id)).toMatchObject({ result: {} });
      expect(await vault().sessionCreds("claude")).toMatchObject({ oauthToken: token });
    }

    await vault().remove("claude", SUBSCRIPTION);
    socket.close();
  });

  it("signs in to ChatGPT with a device code the Vault polls for", async () => {
    const name = crypto.randomUUID();
    const socket = await connect(name);
    const client = follow(socket);
    socket.send(JSON.stringify({ type: "chatgpt-login", id: "login" }));
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === "login"));
    const started = client.frames.find((frame) => frame.type === "result" && frame.id === "login");
    const code = started?.type === "result" ? started.result : null;
    expect(code).toMatchObject({ userCode: expect.stringMatching(/^FAKE-/), verificationUrl: "https://auth.openai.com/codex/device" });
    // SAFETY: matched just above.
    const login = (code as { loginId: string }).loginId;

    // The fake asks to wait once; the alarm polls again a second later.
    let state: JsonValue = "pending";

    for (let i = 0; i < 40 && state === "pending"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const id = `poll-${i}`;
      socket.send(JSON.stringify({ type: "chatgpt-poll", id, login }));
      await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === id));
      const reply = client.frames.find((frame) => frame.type === "result" && frame.id === id);
      state = reply?.type === "result" ? reply.result : null;
    }

    expect(state).toBe("done");
    await client.until(() =>
      client.frames.some((frame) => frame.type === "subscriptions" && frame.subscriptions.some((each) => each.kind === "chatgpt" && each.connected))
    );
    expect(await vault().sessionCreds("codex")).toMatchObject({ accountId: "acct-fake", refreshToken: null });

    socket.send(JSON.stringify({ type: "remove-subscription", id: "remove", kind: "chatgpt" }));
    await until(async () => (await vault().sessionCreds("codex")) === null, "the login removed");
    socket.close();
  });
});

describe("handing a machine's task the subscriptions", () => {
  it("hands Claude's token to a machine that isn't signed in, or uses ky's login, and keeps it out of storage", async () => {
    const token = claudeToken();
    await vault().put("claude", SUBSCRIPTION, { oauthToken: token });

    try {
      const bare = crypto.randomUUID();
      const out = await runner(bare, "mac", SIGNED_OUT);
      await prompt(bare, "machine build it");
      expect((await out.run()).creds).toEqual({ claude: { oauthToken: token } });
      expect(await stored(bare)).not.toContain(token);
      out.socket.close();

      const own = crypto.randomUUID();
      const signed = await runner(own, "mac", SIGNED_IN);
      await prompt(own, "machine build it");
      expect((await signed.run()).creds).toBeUndefined();

      await inside(own, (instance) => instance.machines.configure("mac", { login: "ky" }));
      await prompt(own, "machine build it again");
      expect((await signed.run()).creds).toEqual({ claude: { oauthToken: token } });
      signed.socket.close();
    } finally {
      await vault().remove("claude", SUBSCRIPTION);
    }
  });

  it("pushes a Codex task a refreshed ChatGPT token before the one it has expires", async () => {
    const now = Date.now();
    await vault().put("chatgpt", SUBSCRIPTION, {
      accessToken: "access-first",
      refreshToken: "refresh-first",
      idToken: "id-first",
      accountId: "acct-fake",
      expiresAt: now + 2 * 60 * 60_000
    });

    try {
      const name = crypto.randomUUID();
      const mac = await runner(name, "mac", SIGNED_OUT);
      await prompt(name, codexRun("a long migration"));
      const run = await mac.run();
      expect(run.creds).toEqual({
        codex: { accessToken: "access-first", refreshToken: null, idToken: "id-first", accountId: "acct-fake", expiresAt: now + 2 * 60 * 60_000 }
      });
      expect(await stored(name)).not.toContain("access-first");

      // An hour and a minute on, under an hour is left: the runner's next hello brings a refreshed token.
      const hello = () => mac.send({ type: "hello", protocol: PROTOCOL, version: "test", active: [run.task], facts: SIGNED_OUT });
      await vault().ahead(61 * 60_000);
      hello();
      const renewed = await mac.next();
      expect(renewed).toMatchObject({ type: "creds", task: run.task, codex: { accountId: "acct-fake", refreshToken: null } });
      expect(renewed.type === "creds" && renewed.codex.accessToken).not.toBe("access-first");

      // Another hello with nothing newer sends nothing more.
      hello();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(mac.commands.filter((command) => command.type === "creds")).toEqual([]);

      mac.send({ type: "result", task: run.task, turn: run.turn, ok: true, text: "migrated", session: "t-1", agent: "codex" });
      await until(
        async () => (await inside(name, (_instance, state) => state.storage.sql.exec("SELECT 1 FROM ky_machine_logins").toArray().length)) === 0,
        "the task's login forgotten once it ended"
      );
      mac.socket.close();
    } finally {
      await vault().ahead(0);
      await vault().remove("chatgpt", SUBSCRIPTION);
    }
  });
});
