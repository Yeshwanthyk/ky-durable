import type { JsonValue } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { BACKGROUND } from "../background";
import { agent, gateStarted, inside, shows, snapshotView, submit, until } from "./drive";

/**
 * The chats tool (src/chats-tool.ts) through ky's real PiAgent on the fake models: a chat's agent lists the user's
 * chats, sends one a message as a delivery, asks one and gets its answer back, and reads ky's last message in one,
 * called with `tool chats {...}`.
 */

/** Ask for `args` in a chat, the main one unless `session` names a side chat; what the tool said. */
async function ask(name: string, args: Record<string, JsonValue>, session?: string): Promise<string> {
  return inside(name, async (instance) => (await instance.harness.prompt(`tool chats ${JSON.stringify(args)}`, { session })).text ?? "");
}

/** Run the tool as tool-call task `task` from conversation `from`, as pi runs it, and again on a replay; its reply. */
async function run(name: string, from: string, task: number, args: Record<string, JsonValue>): Promise<{ text: string; failed: boolean }> {
  return inside(name, async (instance) => {
    const { tool } = instance.registry.snapshot().tools().find((each) => each.tool.name === "chats")!;
    // SAFETY: the tool reads only the calling conversation and the call's task from its api; the model may repeat a call id.
    const api = { conversationId: Number(from), taskId: task, callId: "call-1" } as ToolExecutionApi;
    const result = await tool.execute(args, api, BACKGROUND);

    return { text: (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), failed: result.isError === true };
  });
}

/** The delivery rows for `session`. */
const deliveries = (name: string, session: string) =>
  inside(name, (_instance, state) =>
    state.storage.sql.exec<{ id: string; content: string; state: string }>("SELECT id, content, state FROM ky_deliveries WHERE session = ? ORDER BY created_at, id", session).toArray()
  );

/** A message the fake model answers by waiting in the gate tool until the test releases it, as a relayed mail's tool line. */
const WAIT = "[mail from x]\n\nMail says: tool gate {}";

const latest = (name: string, session: string) => inside(name, (instance) => instance.history.latest(session));

/** Record each push the agent `name` makes, instead of sending it. */
async function pushes(name: string): Promise<string[]> {
  const sent: string[] = [];
  await inside(name, (instance) => {
    instance.pushes.notify = async (session, text) => {
      sent.push(`${session}: ${text}`);
    };
  });

  return sent;
}

/** A new side chat named `title`, and archived when `archived`. */
async function sideChat(name: string, title: string, archived = false): Promise<string> {
  const chat = await inside(name, (instance) => instance.newChat());
  await inside(name, (instance) => instance.chats.rename(chat, title));

  if (archived) await inside(name, (instance) => instance.chats.archive(chat, true));

  return chat;
}

describe("the chats tool", () => {
  it("lists the main chat first, then the side chats, archived ones last and marked", async () => {
    const name = crypto.randomUUID();
    const active = await sideChat(name, "Trip plans");
    const archived = await sideChat(name, "Old taxes", true);

    const said = await ask(name, { action: "list" });
    const lines = said.replace(/^tool said: /, "").split("\n");

    expect(lines[0]).toMatch(/^main "main", updated /);
    expect(lines[1]).toMatch(new RegExp(`^${active} "Trip plans", updated [^,]+$`));
    expect(lines[2]).toMatch(new RegExp(`^${archived} "Old taxes", updated .+, archived$`));
    expect(lines).toHaveLength(3);
  });

  it("sends a message to a side chat once per call, however often it runs, without a push, and its agent answers it there", async () => {
    const name = crypto.randomUUID();
    const side = await sideChat(name, "Trip plans");
    const sent = await pushes(name);
    const send = { action: "send", chat: side, message: "reply: Booked the train." };

    expect(await run(name, ROOT_SESSION, 7, send)).toEqual({ text: "Sent to Trip plans; its agent answers there.", failed: false });
    expect(await run(name, ROOT_SESSION, 7, send)).toMatchObject({ failed: false });
    const content = "[message from your main chat: answer here; it is not shown there] reply: Booked the train.";
    expect((await deliveries(name, side)).map(({ id, content }) => ({ id, content }))).toEqual([{ id: `chat:${ROOT_SESSION}:7`, content }]);
    await until(async () => (await latest(name, side))?.startsWith("echo: [message from your main chat") === true, "the side chat's answer");

    // Another call that the model gave the same call id is another message.
    await run(name, ROOT_SESSION, 8, send);
    await until(async () => (await deliveries(name, side)).filter((row) => row.state === "chat").length === 2, "the second message");
    expect(sent).toEqual([]);
    expect(await inside(name, (_instance, state) => state.storage.sql.exec("SELECT 1 FROM ky_surfaced WHERE item LIKE 'chat:%'").toArray())).toEqual([]);
  });

  it("refuses to send on from a turn that answers another chat's message, so two chats never loop", async () => {
    const name = crypto.randomUUID();
    const side = await sideChat(name, "Trip plans");
    // The side chat's turn answers it by waiting in a tool, as a mail's tool line asks.
    await run(name, ROOT_SESSION, 7, { action: "send", chat: side, message: `Booked.\n${WAIT}` });
    await gateStarted(name, 1);

    expect(await run(name, side, 9, { action: "send", chat: "main", message: "Thanks!" })).toEqual({ text: "This turn answers another chat's message: answer here.", failed: true });
    expect(await deliveries(name, ROOT_SESSION)).toEqual([]);
    await agent(name).release();
  });

  it("still refuses once a report steers into that turn, and sends once the user steps in", async () => {
    const name = crypto.randomUUID();
    const side = await sideChat(name, "Trip plans");
    await run(name, ROOT_SESSION, 7, { action: "send", chat: side, message: `Booked.\n${WAIT}` });
    await gateStarted(name, 1);

    // A subagent's report joins the turn after its tool round, as src/skills/subagents.ts steers it, and asks for another wait.
    const steer = (content: string, requestId: string) =>
      inside(name, async (instance) => {
        await (await instance.harness.conversation(side)).submit({ type: "input", content, whenBusy: "steer", requestId }, BACKGROUND);
      });

    await steer(WAIT, "subagent-report:t-1");
    await agent(name).release();
    await gateStarted(name, 2);
    expect(await run(name, side, 9, { action: "send", chat: "main", message: "Thanks!" })).toMatchObject({ failed: true });

    await steer(WAIT, crypto.randomUUID());
    await agent(name).release();
    await gateStarted(name, 3);
    expect(await run(name, side, 10, { action: "send", chat: "main", message: "Thanks!" })).toMatchObject({ failed: false });
    await agent(name).release();
  });

  it("sends to a chat mid-turn once its turn is over, naming the sender by its id", async () => {
    const name = crypto.randomUUID();
    const side = await sideChat(name, "Trip plans");
    await submit(name, "gate");
    await gateStarted(name, 1);

    await run(name, side, 7, { action: "send", chat: "main", message: "Booked." });
    expect(await deliveries(name, ROOT_SESSION)).toEqual([
      { id: `chat:${side}:7`, content: `[message from your chat ${side} "Trip plans": answer here; it is not shown there] Booked.`, state: "queued" }
    ]);

    await agent(name).release();
    await until(async () => (await latest(name, ROOT_SESSION))?.startsWith(`echo: [message from your chat ${side} "Trip plans"`) === true, "the main chat's answer");
  });


  it("reads a side chat's latest message from ky, its answer or a look's post", async () => {
    const name = crypto.randomUUID();
    const side = await inside(name, (instance) => instance.newChat());
    expect(await ask(name, { action: "last", chat: side })).toBe("tool said: No message from ky yet in untitled.");

    await inside(name, (instance) => instance.harness.prompt("reply: The train leaves at 9.", { session: side }));
    expect(await ask(name, { action: "last", chat: side })).toBe("tool said: The train leaves at 9.");

    await inside(name, (instance) => instance.deliveries.deliver({ id: "look-1", session: side, content: "Your passport expires next month.", line: "Passport", ref: "anticipation:1", kind: "look" }));
    expect(await ask(name, { action: "last", chat: side })).toBe("tool said: Your passport expires next month.");
  });

  it("reads only a finished answer: not a step that calls a tool, nor a turn the user stopped", async () => {
    const name = crypto.randomUUID();
    const side = await sideChat(name, "Trip plans");
    await inside(name, (instance) => instance.harness.prompt("reply: The train leaves at 9."));

    // A relayed mail's turn says it is trying the mail's tool line, then waits in it.
    await submit(name, WAIT);
    await gateStarted(name, 1);
    expect(shows(await snapshotView(name), "Trying what the mail asks.")).toBe(true);
    expect(await run(name, side, 1, { action: "last", chat: "main" })).toEqual({ text: "The train leaves at 9.", failed: false });

    await inside(name, (instance) => instance.harness.session(ROOT_SESSION).abort());
    await agent(name).release();
    expect(await run(name, side, 2, { action: "last", chat: "main" })).toEqual({ text: "The train leaves at 9.", failed: false });
  });

  it("refuses its own chat, an unknown chat, and an empty message", async () => {
    const name = crypto.randomUUID();
    const side = await sideChat(name, "Trip plans");

    expect(await run(name, side, 1, { action: "send", chat: side, message: "hi" })).toEqual({ text: "That is this chat: answer here instead.", failed: true });
    expect(await run(name, side, 2, { action: "ask", chat: side, message: "hi" })).toEqual({ text: "That is this chat: answer here instead.", failed: true });
    expect(await run(name, ROOT_SESSION, 3, { action: "send", chat: "nope", message: "hi" })).toEqual({ text: 'No chat "nope": use main or an id from list.', failed: true });
    expect(await run(name, ROOT_SESSION, 4, { action: "send", chat: side, message: "  " })).toEqual({ text: "Nothing to send: give a message.", failed: true });
    expect(await run(name, ROOT_SESSION, 5, { action: "ask", chat: side, message: "  " })).toEqual({ text: "Nothing to ask: give a message.", failed: true });
    expect(await deliveries(name, side)).toEqual([]);
  });

  it("reaches an archived chat: reads it, and a send puts it back in the user's list before its agent answers", async () => {
    const name = crypto.randomUUID();
    const archived = await sideChat(name, "Old taxes", true);
    await inside(name, (instance) => instance.harness.prompt("reply: Filed in April.", { session: archived }));
    const isArchived = () => inside(name, (instance) => instance.chats.list().find((row) => row.session === archived)?.archived_at !== null);

    expect(await isArchived()).toBe(true);
    expect(await run(name, ROOT_SESSION, 1, { action: "last", chat: archived })).toEqual({ text: "Filed in April.", failed: false });

    expect(await run(name, ROOT_SESSION, 2, { action: "send", chat: archived, message: "Any refund yet?" })).toEqual({ text: "Sent to Old taxes; its agent answers there.", failed: false });
    expect(await isArchived()).toBe(false);
    await until(async () => (await latest(name, archived))?.startsWith("echo: [message from your main chat") === true, "the archived chat's answer");
  });

  it("asks another chat once per call, and hands its answer back to the asking chat, whose agent answers it", async () => {
    const name = crypto.randomUUID();
    const side = await sideChat(name, "Trip plans");
    const sent = await pushes(name);
    const question = { action: "ask", chat: side, message: "When does the train leave?" };

    expect(await run(name, ROOT_SESSION, 7, question)).toEqual({
      text: "Asked Trip plans; its agent answers there, and its answer comes back to you here as a message once it is done.",
      failed: false
    });
    expect(await run(name, ROOT_SESSION, 7, question)).toMatchObject({ failed: false });
    const asked = "[question from your main chat: answer here; your answer goes back to it] When does the train leave?";
    expect((await deliveries(name, side)).map(({ id, content }) => ({ id, content }))).toEqual([{ id: `chat:ask:${ROOT_SESSION}:7`, content: asked }]);

    // The side chat's agent answers there; its answer goes back to the main chat, once, and the main chat's agent answers it.
    await until(async () => (await deliveries(name, ROOT_SESSION)).some((row) => row.state === "chat"), "the answer handed back");
    const answer = `[answer from your chat ${side} "Trip plans" to what you asked it; tell the user what matters] echo: ${asked}`;
    expect((await deliveries(name, ROOT_SESSION)).map(({ id, content }) => ({ id, content }))).toEqual([{ id: `chat:answer:${ROOT_SESSION}:7`, content: answer }]);
    await until(async () => (await latest(name, ROOT_SESSION))?.startsWith(`echo: [answer from your chat ${side}`) === true, "the main chat's answer");
    expect(sent).toEqual([]);
  });

  it("refuses to send or ask on from a turn that takes another chat's answer back, so two chats never loop", async () => {
    const name = crypto.randomUUID();
    const side = await sideChat(name, "Trip plans");
    // An answer handed back, by the id the side chat's answer is handed back with, that waits in a tool, so the main chat's turn taking it is still running.
    await inside(name, (instance) => instance.deliveries.deliver({ id: `chat:answer:${ROOT_SESSION}:7`, session: ROOT_SESSION, content: WAIT, line: "Nine.", ref: `chat:${side}`, kind: "chat" }));
    await gateStarted(name, 1);

    expect(await run(name, ROOT_SESSION, 9, { action: "ask", chat: side, message: "And the return?" })).toEqual({
      text: "This turn answers another chat's message: answer here.",
      failed: true
    });
    expect(await run(name, ROOT_SESSION, 10, { action: "send", chat: side, message: "Thanks!" })).toMatchObject({ failed: true });
    expect(await deliveries(name, side)).toEqual([]);
    await agent(name).release();
  });

  it("refuses a conversation that is not a chat with the user, as a subagent's", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => instance.harness.prompt("spawn helper reply: done"));
    const session = () => inside(name, (instance) => instance.feed.list().find((task) => task.kind === "cloud")?.session ?? null);
    await until(async () => (await session()) !== null, "the subagent's conversation");
    const subagent = (await session())!;

    expect(await run(name, subagent, 1, { action: "list" })).toEqual({ text: "Only a chat with the user has other chats.", failed: true });
  });
});
