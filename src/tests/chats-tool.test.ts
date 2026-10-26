import type { JsonValue } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { evictDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { placedBy } from "../history/wiring";
import { agent, gateStarted, inside, until } from "./drive";

/**
 * The chats tool (src/chats/tool.ts) through ky's real PiAgent on the fake models: a chat opens side chats, steers
 * the ones it opened, and inspects them; a chat it opened runs none. The fake model answers an opener's message
 * as the message after its header, so `create` with `gate` leaves the opened chat working until the test releases it.
 */

/** Run the tool as tool-call task `task` from conversation `from`, as pi runs it; its reply. */
async function run(name: string, from: string, task: number, args: Record<string, JsonValue>): Promise<{ text: string; failed: boolean }> {
  return inside(name, async (instance) => {
    // The harness, and with it the tools, starts with the first conversation it opens.
    await instance.harness.conversation(ROOT_SESSION);
    const { tool } = instance.registry.snapshot().tools().find((each) => each.tool.name === "chats")!;
    // SAFETY: the tool reads only the calling conversation and the call's task from its api.
    const api = { conversationId: Number(from), taskId: task, callId: "call-1" } as ToolExecutionApi;
    const result = await tool.execute(args, api, BACKGROUND_CONTEXT);

    return { text: (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), failed: result.isError === true };
  });
}

/** The chat a create's reply names. */
const opened = (text: string) => /^Opened chat (\S+);/.exec(text)?.[1] ?? "";

/** Create a chat from `from` as task `task`; its session. */
async function create(name: string, from: string, task: number, message: string, title?: string): Promise<string> {
  const said = await run(name, from, task, title === undefined ? { action: "create", message } : { action: "create", message, title });
  expect(said.failed).toBe(false);

  return opened(said.text);
}

const latest = (name: string, session: string) => inside(name, (instance) => instance.history.latest(session));

const row = (name: string, session: string) => inside(name, (instance) => instance.chats.list().find((each) => each.session === session));

/** The request ids of the user entries of `session`, oldest first: who placed each message the chat's agent was given (src/history.ts placedBy). */
const placed = (name: string, session: string) =>
  inside(name, (_instance, state) => {
    const users = state.storage.sql
      .exec<{ id: number }>(`SELECT id FROM pi_entries WHERE conversation_id = ? AND json_extract(record, '$.kind') = 'pi.user' ORDER BY id`, Number(session))
      .toArray()
      .map((each) => each.id);

    const by = placedBy(state.storage.sql, users);

    return users.map((id) => by.get(id));
  });

/** A side chat the user opened. */
const userChat = (name: string) => inside(name, (instance) => instance.newChat());

describe("the chats tool", () => {
  it("opens one side chat per call however often it runs, named and steered by the chat that opened it, and its agent starts on the message there", async () => {
    const name = crypto.randomUUID();
    const first = await create(name, ROOT_SESSION, 7, "reply: Here is what intermittent fasting asks of you.", "Intermittent fasting");

    expect(await create(name, ROOT_SESSION, 7, "reply: Here is what intermittent fasting asks of you.", "Intermittent fasting")).toBe(first);
    expect(await row(name, first)).toMatchObject({ title: "Intermittent fasting", opened_by: ROOT_SESSION, opened_request: `chat-create:${ROOT_SESSION}:7`, archived_at: null });
    await until(async () => (await latest(name, first)) === "Here is what intermittent fasting asks of you.", "the opened chat's answer");

    // One message, from the opener: its request is named, so it is never the user's.
    expect(await placed(name, first)).toEqual([`chat-create:${ROOT_SESSION}:7`]);
    // Another call is another chat, named from its message when no title is given.
    const second = await create(name, ROOT_SESSION, 8, "reply: Yesterday's top stories.");
    expect(second).not.toBe(first);
    expect((await row(name, second))?.title).toMatch(/^(Named: )?reply: Yesterday's top stories\.$/);
  });

  it("opens one chat across an eviction: the call run again finds the chat it opened", async () => {
    const name = crypto.randomUUID();
    const first = await create(name, ROOT_SESSION, 7, "reply: Hello.");
    await until(async () => (await latest(name, first)) === "Hello.", "the opened chat's answer");

    await evictDurableObject(agent(name));
    expect(await create(name, ROOT_SESSION, 7, "reply: Hello.")).toBe(first);
    expect(await inside(name, (instance) => instance.chats.list().length)).toBe(1);
    expect(await placed(name, first)).toEqual([`chat-create:${ROOT_SESSION}:7`]);
  });

  it("steers a working chat into the turn it is in, once per call, and inspect shows it working, then idle with its answer", async () => {
    const name = crypto.randomUUID();
    const chat = await create(name, ROOT_SESSION, 1, "gate", "gate");
    await gateStarted(name, 1);

    expect(await run(name, ROOT_SESSION, 2, { action: "inspect", chat })).toEqual({ text: `"gate" is working; no message from ky in it yet.`, failed: false });
    const steer = { action: "steer", chat, message: "reply: Make it the top 15, not 10." };
    expect(await run(name, ROOT_SESSION, 3, steer)).toEqual({ text: `Steered "gate"; its agent answers there.`, failed: false });
    expect(await run(name, ROOT_SESSION, 3, steer)).toMatchObject({ failed: false });

    await agent(name).release();
    await until(async () => (await latest(name, chat)) === "Make it the top 15, not 10.", "the steered answer");
    expect(await placed(name, chat)).toEqual([`chat-create:${ROOT_SESSION}:1`, `chat-steer:${ROOT_SESSION}:3`]);
    expect(await run(name, ROOT_SESSION, 4, { action: "inspect", chat })).toEqual({ text: `"gate" is idle. ky's latest message there:\nMake it the top 15, not 10.`, failed: false });
  });

  it("steers an idle chat into a new turn, and an archived one back into the user's list", async () => {
    const name = crypto.randomUUID();
    const chat = await create(name, ROOT_SESSION, 1, "reply: Done.", "News");
    await until(async () => (await latest(name, chat)) === "Done.", "the first answer");
    await inside(name, (instance) => instance.chats.archive(chat, true));

    await run(name, ROOT_SESSION, 2, { action: "steer", chat, message: "reply: And the comments?" });
    expect((await row(name, chat))?.archived_at).toBeNull();
    await until(async () => (await latest(name, chat)) === "And the comments?", "the steered turn");
  });

  it("inspect with no chat lists only the chats this chat opened, each working or idle", async () => {
    const name = crypto.randomUUID();
    const mine = await create(name, ROOT_SESSION, 1, "gate", "Fasting");
    await gateStarted(name, 1);
    await userChat(name);
    const side = await userChat(name);
    await create(name, side, 1, "reply: Theirs.");

    const lines = (await run(name, ROOT_SESSION, 2, { action: "inspect" })).text.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^${mine} "Fasting", working, updated `));
    expect(await run(name, await userChat(name), 1, { action: "inspect" })).toEqual({ text: "This chat has opened no chats yet.", failed: false });
    await agent(name).release();
  });

  it("opens a chat when the main chat's model calls it, as the user asked", async () => {
    const name = crypto.randomUUID();
    const said = await inside(name, async (instance) => (await instance.harness.prompt(`tool chats ${JSON.stringify({ action: "create", message: "reply: On it.", title: "HN yesterday" })}`)).text ?? "");

    expect(said).toMatch(/^tool said: Opened chat \S+; its agent answers there/);
    const chat = (await inside(name, (instance) => instance.chats.list()))[0]!;
    expect(chat).toMatchObject({ title: "HN yesterday", opened_by: ROOT_SESSION });
    await until(async () => (await latest(name, chat.session)) === "On it.", "the opened chat's answer");
  });
});

const byText = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "");

/** One generated call: who calls (an index into the chats so far), what, at which chat, run once or twice as a replay. */
type Call = { readonly from: number; readonly action: "create" | "steer" | "inspect"; readonly to: number; readonly twice: boolean };

const calls = fc.array(
  fc.record({ from: fc.nat(7), action: fc.constantFrom("create" as const, "steer" as const, "inspect" as const), to: fc.nat(7), twice: fc.boolean() }),
  { minLength: 1, maxLength: 12 }
);

describe("chats run one way, over generated calls", () => {
  /**
   * From the main chat, a side chat the user opened, and every chat those open, any of them calls create, steer or
   * inspect at any chat, sometimes twice as a replay. Once all are idle:
   * - P1: a chat a chat opened was opened by the main chat or one the user opened: one level, never deeper.
   * - P2: a call from a chat a chat opened is refused, and opens or gives nothing.
   * - P3: a chat a chat opened was given messages only by its opener's create and steers, each request once.
   * - P4: no chat is given a message from a chat it did not open: the main chat and the user's get none at all.
   * - P5: one create call, however often it runs, opens one chat.
   */
  it("keeps every chat a chat opened one level down, given messages only by its opener", async () => {
    await fc.assert(
      fc.asyncProperty(calls, async (ops: readonly Call[]) => {
        const name = crypto.randomUUID();
        const users = await userChat(name);
        const chats = [ROOT_SESSION, users];
        const creates: string[] = [];

        for (const [task, op] of ops.entries()) {
          const from = chats[op.from % chats.length]!;
          const to = chats[op.to % chats.length]!;
          const args: Record<string, JsonValue> = op.action === "create" ? { action: "create", message: `reply: made ${task}` } : { action: op.action, chat: to, message: `reply: steer ${task}` };
          const managed = await inside(name, (instance) => instance.chats.openedBy(from) !== null);
          const before = await inside(name, (instance) => instance.chats.list().length);
          const first = await run(name, from, task, args);
          const again = op.twice ? await run(name, from, task, args) : first;

          if (managed) {
            // P2
            expect(first.failed && again.failed).toBe(true);
            expect(await inside(name, (instance) => instance.chats.list().length)).toBe(before);
          } else if (op.action === "create") {
            // P5
            expect(opened(again.text)).toBe(opened(first.text));
            chats.push(opened(first.text));
            creates.push(`chat-create:${from}:${task}`);
          }
        }

        await inside(name, async (instance) => {
          for (const session of chats) await (await instance.harness.conversation(session)).waitForIdle(BACKGROUND_CONTEXT);
        });
        const rows = await inside(name, (instance) => instance.chats.list());

        for (const session of chats) {
          const row = rows.find((each) => each.session === session);
          const requests = await placed(name, session);

          if (row?.opened_by) {
            // P1
            expect(rows.find((each) => each.session === row.opened_by)?.opened_by ?? null).toBeNull();
            // P3
            expect(requests[0]).toBe(row.opened_request);
            expect(requests.every((request) => request?.startsWith(`chat-create:${row.opened_by}:`) || request?.startsWith(`chat-steer:${row.opened_by}:`))).toBe(true);
            expect(new Set(requests).size).toBe(requests.length);
          } else {
            // P4
            expect(requests.filter((request) => request?.startsWith("chat-"))).toEqual([]);
          }
        }

        expect(rows.filter((row) => row.opened_by !== null).map((row) => row.opened_request).toSorted(byText)).toEqual(creates.toSorted(byText));
      }),
      { numRuns: 25 }
    );
  });
});
