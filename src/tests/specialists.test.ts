import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { PiClientMessage, PiServerMessage } from "../protocol";
import { connect, follow, type Follower, inside, prompt, said, shows, snapshotView, tasks, until } from "./drive";
import { decodeNewChat } from "./frames";

/** Specialists through ky's real PiAgent on the faux model: briefs, asks, consults, and discussions. */

type Frame<T extends PiServerMessage["type"]> = Extract<PiServerMessage, { type: T }>;

const tool = (name: string, args: Record<string, JsonValue>) => `tool ${name} ${JSON.stringify(args)}`;

const ask = (specialist: string, message: string) => tool("subagent", { action: "ask", specialist, message });

/** Make specialists straight in storage, as the user's panel does. */
const make = (name: string, ...ids: string[]) =>
  inside(name, (instance) => {
    for (const id of ids) instance.specialists.create(id, { description: `The ${id}.`, brief: `# @${id}\nBe a good ${id}.` }, "user");
  });

/** The system entries of every request whose prompt names `who`. */
const requests = (name: string, who: string) =>
  inside(name, (instance) => instance.boundary.calls.filter((each) => each.system.includes(who)).map((each) => each.system));

/** The text a specialist's home conversation shows. */
async function home(name: string, id: string): Promise<string> {
  const session = await inside(name, (instance) => instance.specialists.get(id)?.session ?? null);

  if (session === null) return "";
  const view = await snapshotView(name, session);

  return view.messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).join("\n");
}

async function session(name: string, query = ""): Promise<{ socket: WebSocket; client: Follower }> {
  const socket = await connect(name, query);
  const client = follow(socket);
  await client.until(() => client.frames.some((frame) => frame.type === "events"));

  return { socket, client };
}

async function command(socket: WebSocket, client: Follower, message: PiClientMessage): Promise<Frame<"result"> | Frame<"error">> {
  const id = crypto.randomUUID();
  socket.send(JSON.stringify({ ...message, id }));

  const reply = () =>
    client.frames.find(
      (frame): frame is Frame<"result"> | Frame<"error"> => (frame.type === "result" || frame.type === "error") && frame.id === id
    );

  await client.until(() => reply() !== undefined);

  return reply()!;
}

const latest = (client: Follower) =>
  client.frames.filter((frame): frame is Frame<"specialists"> => frame.type === "specialists").at(-1)?.specialists;

describe("specialists", () => {
  it("keeps every brief version apart from SOUL.md's", async () => {
    const name = crypto.randomUUID();
    const said = (text: string) => prompt(name, text).then((result) => result.text);

    expect(await said(tool("specialist", { action: "create", id: "eng", description: "Builds things.", brief: "Be exact." }))).toBe(
      "tool said: Created @eng."
    );
    expect(await said(tool("specialist", { action: "patch", id: "eng", old: "exact", new: "brief" }))).toBe(
      "tool said: Saved patch of @eng's brief (version 2)."
    );
    expect(await said(tool("specialist", { action: "view", id: "eng" }))).toBe("tool said: @eng: Builds things.\n\nBe brief.");
    await said(tool("specialist", { action: "revert", id: "eng", version: 1 }));

    const [brief, soul] = await inside(name, (instance) => [instance.specialists.brief("eng").history(), instance.soul.history()]);
    expect(brief.map((each) => [each.id, each.action, each.actor])).toEqual([
      [3, "revert", "agent"],
      [2, "patch", "agent"],
      [1, "create", "agent"]
    ]);
    expect(soul.map((each) => each.actor)).toEqual(["template"]);
    expect(await said(tool("specialist", { action: "create", id: "Bad Id", description: "x", brief: "x" }))).toMatch(/^tool failed: [\s\S]*lowercase/);
  });

  it("is listed, saved and edited from the panel", async () => {
    const name = crypto.randomUUID();
    const { socket, client } = await session(name);
    await client.until(() => latest(client) !== undefined);
    expect(latest(client)).toEqual([]);

    const draft = { description: "Finds sources.", brief: "Cite everything." };
    expect(await command(socket, client, { type: "specialist-save", specialist: "researcher", create: true, draft })).toMatchObject({
      type: "result",
      result: {}
    });
    expect(await command(socket, client, { type: "specialist-save", specialist: "researcher", create: true, draft })).toMatchObject({
      result: { refused: "@researcher already exists." }
    });
    await client.until(() => latest(client)?.[0]?.brief.body === "Cite everything.");

    await command(socket, client, { type: "specialist-brief", specialist: "researcher", change: { action: "edit", body: "Cite twice." } });
    await command(socket, client, { type: "specialist-save", specialist: "researcher", draft: { description: "Digs." } });
    await client.until(() => latest(client)?.[0]?.description === "Digs." && latest(client)?.[0]?.brief.version === 2);

    const history = await command(socket, client, { type: "specialist-history", specialist: "researcher" });
    expect(history).toMatchObject({ type: "result", result: [{ id: 2, actor: "user" }, { id: 1, actor: "user" }] });
    expect(await command(socket, client, { type: "specialist-history", specialist: "nobody" })).toMatchObject({ type: "error" });
    socket.close();
  });

  it("answers an ask from its home conversation, on its brief, without memory", async () => {
    const name = crypto.randomUUID();
    await make(name, "eng");
    await prompt(name, "hello");
    expect(await requests(name, "Specialists:\\n- @eng: The eng.")).not.toHaveLength(0);

    expect((await prompt(name, ask("eng", "fix the build"))).text).toBe("tool said: Asked @eng.");
    await said(name, "[specialist @eng answered: pass on what matters] echo: fix the build");
    expect(await tasks(name)).toContainEqual(expect.objectContaining({ kind: "cloud", worker: "@eng", status: "done" }));

    const [request] = await requests(name, "You are @eng");
    expect(request).toContain("<brief>\\n# @eng\\nBe a good eng.\\n</brief>");
    // The wake, not the rules that mention it.
    expect(request).not.toContain("<memory>\\n");
    expect(request).not.toContain("<soul>");
  });

  it("shares one home conversation between the main chat and a side chat", async () => {
    const name = crypto.randomUUID();
    await make(name, "eng");
    await prompt(name, ask("eng", "first job"));
    await until(async () => (await home(name, "eng")).includes("echo: first job"), "the first answer");
    const first = await inside(name, (instance) => instance.specialists.get("eng")?.session);

    const main = await session(name);
    const created = await command(main.socket, main.client, { type: "new-chat" });
    const chat = created.type === "result" ? (decodeNewChat(created.result) ?? "") : "";
    const side = await session(name, `?session=${chat}`);
    side.socket.send(JSON.stringify({ type: "submit", input: ask("eng", "second job") }));
    await side.client.until(() => shows(side.client.view(), "[specialist @eng answered"));

    expect(await inside(name, (instance) => instance.specialists.get("eng")?.session)).toBe(first);
    expect(await home(name, "eng")).toContain("echo: second job");
    main.socket.close();
    side.socket.close();
  });

  it("consults a peer in a fresh conversation, which cannot ask on", async () => {
    const name = crypto.randomUUID();
    await make(name, "a", "b", "c");
    await prompt(name, ask("a", ask("b", ask("c", "too deep"))));

    await until(async () => (await home(name, "a")).includes("[specialist @b answered"), "@b's answer to @a");
    expect(await home(name, "a")).toContain("Tool call blocked: You are being consulted");
    const rows = await tasks(name);
    expect(rows.map((row) => row.worker)).toEqual(expect.arrayContaining(["@a", "@a → @b"]));
    expect(rows.map((row) => row.worker)).not.toContain("@b → @c");
    // @b's home conversation was never used: the consult had its own.
    expect(await inside(name, (instance) => instance.specialists.get("b")?.session)).toBeNull();
  });

  it("reads memory but never writes it, and has no persona tools", async () => {
    const name = crypto.randomUUID();
    await make(name, "eng");
    await inside(name, (instance) => instance.memory.note("the deploy key lives in 1Password"));

    await prompt(name, ask("eng", tool("memory_note", { text: "a secret" })));
    await until(async () => (await home(name, "eng")).includes("Tool call blocked: Specialists search memory"), "a blocked note");
    await prompt(name, ask("eng", tool("memory_recall", { regex: "deploy" })));
    await until(async () => (await home(name, "eng")).includes("1Password"), "a recall");
    await prompt(name, ask("eng", tool("specialist", { action: "list" })));
    await until(async () => (await home(name, "eng")).includes("Tool specialist is not available"), "no specialist tool");
    await prompt(name, ask("eng", tool("soul_edit", { action: "view" })));
    await until(async () => (await home(name, "eng")).includes("Tool soul_edit is not available"), "no soul_edit");

    expect(await inside(name, (instance) => instance.memory.view().count)).toBe(1);
  });

  it("holds a discussion and reports both rounds back", async () => {
    const name = crypto.randomUUID();
    await make(name, "a", "b");
    const started = await prompt(name, tool("subagent", { action: "discuss", specialists: ["a", "b"], message: "tabs or spaces" }));
    expect(started.text).toBe("tool said: Started a discussion with @a, @b.");

    await said(name, "## Round 2");
    const view = await snapshotView(name);

    const report = view.messages
      .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
      .find((text) => text.includes("[discussion @a, @b result"))!;

    expect(report).toContain("Topic: tabs or spaces");
    expect(report).toContain("## Round 1\n\n### @a\necho: A discussion with @b.");
    expect(report).toMatch(/## Round 2\n\n### @a\necho: Round 2\. The others answered:\n\n### @b\necho: A discussion with @a/);
    expect(await tasks(name)).toContainEqual(expect.objectContaining({ worker: "@a, @b", status: "done" }));

    const one = await prompt(name, tool("subagent", { action: "discuss", specialists: ["a"], message: "x" }));
    expect(one.text).toBe("tool said: discuss needs 2 to 4 different specialists.");
  });

  it("refuses an @ that is not a specialist", async () => {
    const name = crypto.randomUUID();
    await make(name, "eng");
    const { socket, client } = await session(name);

    expect(await command(socket, client, { type: "submit", input: "@nope hi" })).toMatchObject({
      type: "error",
      message: "No specialist @nope. Specialists: @eng"
    });
    socket.close();
  });
});
