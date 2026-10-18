import type { JsonValue } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { BACKGROUND } from "../background";
import { inside, until } from "./drive";

/**
 * The chats tool (src/chats-tool.ts) through ky's real PiAgent on the fake models: a chat's agent lists the user's
 * chats, sends one a message as a delivery, and reads ky's last message in one, called with `tool chats {...}`.
 */

/** Ask for `args` in a chat, the main one unless `session` names a side chat; what the tool said. */
async function ask(name: string, args: Record<string, JsonValue>, session?: string): Promise<string> {
  return inside(name, async (instance) => (await instance.harness.prompt(`tool chats ${JSON.stringify(args)}`, { session })).text ?? "");
}

/** Run the tool as the call `callId` from conversation `from`, as pi runs it, and again on a replay; its reply. */
async function run(name: string, from: string, callId: string, args: Record<string, JsonValue>): Promise<{ text: string; failed: boolean }> {
  return inside(name, async (instance) => {
    const { tool } = instance.registry.snapshot().tools().find((each) => each.tool.name === "chats")!;
    // SAFETY: the tool reads only the calling conversation and the call's id from its api.
    const api = { conversationId: Number(from), callId } as ToolExecutionApi;
    const result = await tool.execute(args, api, BACKGROUND);

    return { text: (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), failed: result.isError === true };
  });
}

/** The delivery rows for `session`. */
const deliveries = (name: string, session: string) =>
  inside(name, (_instance, state) => state.storage.sql.exec<{ id: string; content: string }>("SELECT id, content FROM ky_deliveries WHERE session = ?", session).toArray());

/** A new side chat named `title`, and archived when `archived`. */
async function sideChat(name: string, title: string, archived = false): Promise<string> {
  const chat = await inside(name, (instance) => instance.newChat());
  await inside(name, (instance) => instance.chats.rename(chat, title));

  if (archived) await inside(name, (instance) => instance.chats.archive(chat, true));

  return chat;
}

describe("the chats tool", () => {
  it("lists the main chat first and the side chats not archived", async () => {
    const name = crypto.randomUUID();
    const active = await sideChat(name, "Trip plans");
    const archived = await sideChat(name, "Old taxes", true);

    const said = await ask(name, { action: "list" });
    const lines = said.replace(/^tool said: /, "").split("\n");

    expect(lines[0]).toMatch(/^main "main", updated /);
    expect(lines.some((line) => line.startsWith(`${active} "Trip plans", updated `))).toBe(true);
    expect(said).not.toContain(archived);
  });

  it("sends a message to a side chat once, however often the call runs, and its agent answers it there", async () => {
    const name = crypto.randomUUID();
    const side = await sideChat(name, "Trip plans");

    expect(await run(name, ROOT_SESSION, "call-1", { action: "send", chat: side, message: "reply: Booked the train." })).toEqual({ text: "Sent to Trip plans; its agent answers there.", failed: false });
    expect(await run(name, ROOT_SESSION, "call-1", { action: "send", chat: side, message: "reply: Booked the train." })).toMatchObject({ failed: false });

    const rows = await deliveries(name, side);
    expect(rows).toEqual([{ id: `chat:${ROOT_SESSION}:call-1`, content: "[message from your main chat: answer here; it is not shown there] reply: Booked the train." }]);
    await until(async () => (await inside(name, (instance) => instance.history.latest(side))) ?.startsWith("echo: [message from your main chat") === true, "the side chat's answer");
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

  it("refuses its own chat, an unknown or archived chat, and an empty message", async () => {
    const name = crypto.randomUUID();
    const side = await sideChat(name, "Trip plans");
    const archived = await sideChat(name, "Old taxes", true);

    expect(await run(name, side, "c1", { action: "send", chat: side, message: "hi" })).toEqual({ text: "That is this chat: answer here instead.", failed: true });
    expect(await run(name, ROOT_SESSION, "c2", { action: "send", chat: "nope", message: "hi" })).toEqual({ text: 'No chat "nope": use main or an id from list.', failed: true });
    expect(await run(name, ROOT_SESSION, "c3", { action: "send", chat: archived, message: "hi" })).toMatchObject({ failed: true });
    expect(await run(name, ROOT_SESSION, "c4", { action: "send", chat: side, message: "  " })).toEqual({ text: "Nothing to send: give a message.", failed: true });
    expect(await deliveries(name, side)).toEqual([]);
    expect(await deliveries(name, archived)).toEqual([]);
  });

  it("refuses a conversation that is not a chat with the user, as a subagent's", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => instance.harness.prompt("spawn helper reply: done"));
    const session = () => inside(name, (instance) => instance.feed.list().find((task) => task.kind === "cloud")?.session ?? null);
    await until(async () => (await session()) !== null, "the subagent's conversation");
    const subagent = (await session())!;

    expect(await run(name, subagent, "c1", { action: "list" })).toEqual({ text: "Only a chat with the user has other chats.", failed: true });
  });
});
