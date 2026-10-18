import type { JsonValue } from "@earendil-works/pi-ai";
import { AssistantEntry, type ConversationId, type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { gateStarted, inside, prompt, submit, tasks, until } from "./drive";
import { GLM, KIMI } from "./stack";
import { BACKGROUND } from "../background";

/** The subagent tool's `last`, and a subagent on a model of its own, through ky's real PiAgent on the fake models. */

const subagent = (name: string, args: Record<string, JsonValue>) =>
  prompt(name, `tool subagent ${JSON.stringify(args)}`).then((result) => result.text);

/** Spawn `agent` with `message` and wait for it to answer. */
async function answered(name: string, agent: string, message: string, extra: Record<string, JsonValue> = {}): Promise<void> {
  expect(await subagent(name, { action: "spawn", name: agent, message, ...extra })).toBe(`tool said: Started ${agent}.`);
  await until(async () => (await tasks(name)).some((task) => task.worker === agent && task.status === "done"), `${agent}'s answer`);
}

// The fake model streams 3 characters every 5ms, too slow to say an answer past the cap, or to repeat `last`'s reply to one.

/** Give `agent`'s conversation a newer answer of `text`, a copy of its last one with that text. */
const answerWith = (name: string, agent: string, text: string) =>
  inside(name, async (instance) => {
    const session = instance.feed.list().find((task) => task.worker === agent)?.session;
    // SAFETY: a cloud task's session is the id, as text, of the subagent's conversation.
    const conversationId = Number(session) as ConversationId;

    await (await instance.harness.pi()).commit(async (tx) => {
      const entries = (await tx.scanEntries({ conversationId }, 50)).items;
      const answer = entries.flatMap((entry) => entry.model ?? []).find((message) => message.role === "assistant")!;
      await tx.appendEntry(AssistantEntry, conversationId, { model: [{ ...answer, content: [{ type: "text", text }] }] });
    }, BACKGROUND);
  });

/** What `last` returns for `agent`, read from the main conversation's transcript as soon as the tool returns. */
async function lastOf(name: string, agent: string): Promise<string | undefined> {
  const transcript = (minEntryId?: EntryId) =>
    inside(name, async (instance) =>
      (await instance.harness.pi()).commit(async (tx) => (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId }, 50)).items, BACKGROUND)
    );

  const after = (await transcript())[0]?.id;
  await submit(name, `tool subagent ${JSON.stringify({ action: "last", name: agent })}`);
  let text: string | undefined;

  await until(async () => {
    const results = (await transcript(after)).flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
    text = results[0]?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

    return text !== undefined;
  }, "last's result");

  return text;
}

/** The models a subagent's requests went to. */
const modelsOf = (name: string, agent: string) =>
  inside(name, (instance) =>
    instance.boundary.calls.filter((call) => call.system.includes(`You are the subagent "${agent}"`)).map((call) => call.model)
  );

describe("the subagent tool", () => {
  it("reads back a subagent's whole latest answer, longer than its status line", async () => {
    const name = crypto.randomUUID();
    const answer = `First line of the findings.\n${"Details. ".repeat(40)}`;
    await answered(name, "researcher", `reply: ${answer}`);

    const status = await subagent(name, { action: "status", name: "researcher" });
    expect(status).not.toContain("Details.");
    expect(await subagent(name, { action: "last", name: "researcher" })).toBe(`tool said: ${answer}`);
  });

  it("cuts a long answer at 16,000 characters and says so", async () => {
    const name = crypto.randomUUID();
    await answered(name, "writer", "reply: short");
    await answerWith(name, "writer", "x".repeat(20_000));

    expect(await lastOf(name, "writer")).toBe(`${"x".repeat(16_000)}…[truncated; 20000 chars total]`);
  });

  it("says when there is no such subagent, or no answer yet", async () => {
    const name = crypto.randomUUID();
    expect(await subagent(name, { action: "last", name: "nobody" })).toBe("tool said: No subagent named nobody.");

    expect(await prompt(name, "spawn waiter gate").then((result) => result.text)).toBe("tool said: Started waiter.");
    await gateStarted(name, 1);
    expect(await subagent(name, { action: "last", name: "waiter" })).toBe("tool said: waiter has no answer yet.");
  });

  it("runs a subagent on the model it was spawned with", async () => {
    const name = crypto.randomUUID();
    await answered(name, "kimi", "reply: done", { model: `workers-ai/${KIMI}` });
    await answered(name, "plain", "reply: done");

    const kimi = await modelsOf(name, "kimi");
    expect(kimi.length).toBeGreaterThan(0);
    expect(kimi).toEqual(kimi.map(() => KIMI));
    expect(await modelsOf(name, "plain")).toEqual([GLM]);
  });

  it("refuses an unknown model and starts nothing", async () => {
    const name = crypto.randomUUID();

    expect(await subagent(name, { action: "spawn", name: "lost", message: "reply: hi", model: "nowhere/some-model" })).toBe(
      "tool said: No connected model nowhere/some-model."
    );
    expect(await subagent(name, { action: "status" })).toBe("tool said: No subagents.");
    expect(await tasks(name)).toEqual([]);
  });
});
