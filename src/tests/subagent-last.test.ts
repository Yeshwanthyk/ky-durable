import type { JsonValue } from "@earendil-works/pi-ai";
import { AssistantEntry, type ConversationId, defineDoc, type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { agent, gateStarted, inside, prompt, submit, tasks, until } from "./drive";
import { GLM, KIMI, OPENCODE_KEY } from "./stack";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelChoice } from "../settings/contract";

const FLASH = { provider: "opencode-go", modelId: "deepseek-v4.1-flash" } as const;

/** Connect OpenCode Go, as the user does by adding its key in Settings. */
const connectOpenCode = (name: string) => inside(name, (instance) => instance.models.addKey("opencode-go", OPENCODE_KEY));

/** The model the main chat's subagent `agent` keeps. */
const kept = (name: string, agent: string) =>
  inside(name, async (instance) =>
    (await instance.harness.pi()).commit(async (tx) => {
      const model = (await tx.doc(Registry, ROOT_CONVERSATION_ID)).agents[agent]?.model;

      return model && { ...model };
    }, BACKGROUND_CONTEXT)
  );

/** The subagent tool's `last`, and a subagent on a model of its own, through ky's real PiAgent on the fake models. */

const subagent = (name: string, args: Record<string, JsonValue>) =>
  prompt(name, `tool subagent ${JSON.stringify(args)}`).then((result) => result.text);

/** The statuses of `agent`'s tasks, oldest first; the feed lists the newest first. */
const statuses = (name: string, agent: string) =>
  tasks(name).then((rows) => rows.filter((row) => row.worker === agent).map((row) => row.status).reverse());

/** Wait until `agent`'s tasks have `wanted` statuses. */
const settled = (name: string, agent: string, wanted: string[]) =>
  until(async () => JSON.stringify(await statuses(name, agent)) === JSON.stringify(wanted), `${agent}: ${wanted.join(", ")}`);

/** Spawn `agent` with `message` and wait for it to answer. */
async function answered(name: string, agent: string, message: string, extra: Record<string, JsonValue> = {}): Promise<void> {
  expect(await subagent(name, { action: "spawn", name: agent, message, ...extra })).toBe(`tool said: Started ${agent}.`);
  await settled(name, agent, ["done"]);
}

// The fake model streams 3 characters every 5ms, too slow to say an answer past the cap, or to repeat `last`'s reply to one.

/** The main chat's subagent registry, by the kind src/skills/subagents.ts keeps it under. */
const Registry = defineDoc<{ agents: Record<string, { reported: EntryId[]; model?: ModelChoice }> }>({
  kind: "ky.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  // Each change is stored as a delta; no full copy is written.
  checkpointWhen: () => false,
  initial: () => ({ agents: {} })
});

/** Give `agent` a newer reported answer of `text`, a copy of its last one with that text. */
const answerWith = (name: string, agent: string, text: string) =>
  inside(name, async (instance) => {
    const session = instance.feed.list().find((task) => task.worker === agent)?.session;
    // SAFETY: a cloud task's session is the id, as text, of the subagent's conversation.
    const conversationId = Number(session) as ConversationId;

    await (await instance.harness.pi()).commit(async (tx) => {
      const entries = (await tx.scanEntries({ conversationId }, 50)).items;
      const answer = entries.flatMap((entry) => entry.model ?? []).find((message) => message.role === "assistant")!;
      const entry = await tx.appendEntry(AssistantEntry, conversationId, { model: [{ ...answer, content: [{ type: "text", text }] }] });
      (await tx.doc(Registry, ROOT_CONVERSATION_ID)).agents[agent]!.reported.push(entry.id);
    }, BACKGROUND_CONTEXT);
  });

/** What `last` returns for `agent`, read from the main conversation's transcript as soon as the tool returns. */
async function lastOf(name: string, agent: string): Promise<string | undefined> {
  const transcript = (minEntryId?: EntryId) =>
    inside(name, async (instance) =>
      (await instance.harness.pi()).commit(async (tx) => (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId }, 50)).items, BACKGROUND_CONTEXT)
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

/** The model and thinking of each request a subagent made. */
const requestsOf = (name: string, agent: string) =>
  inside(name, (instance) =>
    instance.boundary.calls.filter((call) => call.system.includes(`You are the subagent "${agent}"`)).map(({ model, reasoning }) => ({ model, reasoning }))
  );

const modelsOf = (name: string, agent: string) => requestsOf(name, agent).then((requests) => requests.map((request) => request.model));

describe("the subagent tool", () => {
  it("reads back a subagent's whole latest answer, longer than its status line", async () => {
    const name = crypto.randomUUID();
    const answer = `First line of the findings.\n${"Details. ".repeat(40)}`;
    await answered(name, "researcher", `reply: ${answer}`);

    const status = await subagent(name, { action: "status", name: "researcher" });
    expect(status).not.toContain("Details.");
    expect(await subagent(name, { action: "last", name: "researcher" })).toBe(`tool said: ${answer}`);
  });

  it("cuts a long answer at 16,000 characters and says so, never through a character", async () => {
    const name = crypto.randomUUID();
    await answered(name, "writer", "reply: short");
    await answerWith(name, "writer", "x".repeat(20_000));
    expect(await lastOf(name, "writer")).toBe(`${"x".repeat(16_000)}…[truncated; 20000 chars total]`);

    const other = crypto.randomUUID();
    await answered(other, "writer", "reply: short");
    await answerWith(other, "writer", `${"x".repeat(15_999)}😀${"y".repeat(100)}`);
    expect(await lastOf(other, "writer")).toBe(`${"x".repeat(15_999)}…[truncated; 16101 chars total]`);
  });

  it("says when there is no such subagent, or no answer yet", async () => {
    const name = crypto.randomUUID();
    expect(await subagent(name, { action: "last", name: "nobody" })).toBe("tool said: No subagent named nobody.");

    expect(await prompt(name, "spawn waiter gate").then((result) => result.text)).toBe("tool said: Started waiter.");
    await gateStarted(name, 1);
    expect(await subagent(name, { action: "last", name: "waiter" })).toBe("tool said: waiter has no answer yet.");
  });

  it("keeps the last answer through a failed turn and a stopped one", async () => {
    const name = crypto.randomUUID();
    await answered(name, "steady", "reply: first");

    // Escaped, so only the subagent's prompt holds the words that make the fake model refuse.
    await prompt(name, 'tool subagent {"action":"send","name":"steady","message":"model\\u002drefuses"}');
    await settled(name, "steady", ["done", "failed"]);
    expect(await subagent(name, { action: "last", name: "steady" })).toBe("tool said: first");

    await subagent(name, { action: "send", name: "steady", message: "gate" });
    await gateStarted(name, 1);
    expect(await subagent(name, { action: "stop", name: "steady" })).toBe("tool said: Stopped steady.");
    await settled(name, "steady", ["done", "failed", "stopped"]);
    expect(await subagent(name, { action: "last", name: "steady" })).toBe("tool said: first");
  });

  it("runs a subagent on the model it was spawned with, for later sends too, until it is cleared", async () => {
    const name = crypto.randomUUID();
    await answered(name, "kimi", "reply: done", { model: `workers-ai/${KIMI}` });
    await answered(name, "plain", "reply: done");

    expect(await subagent(name, { action: "send", name: "kimi", message: "reply: again" })).toBe("tool said: Sent to kimi.");
    await settled(name, "kimi", ["done", "done"]);
    const kimi = await modelsOf(name, "kimi");
    expect(kimi.length).toBeGreaterThan(1);
    expect(kimi).toEqual(kimi.map(() => KIMI));
    expect(await modelsOf(name, "plain")).toEqual([GLM]);

    await subagent(name, { action: "send", name: "kimi", message: "reply: back", model: "worker" });
    await settled(name, "kimi", ["done", "done", "done"]);
    expect((await modelsOf(name, "kimi")).at(-1)).toBe(GLM);
  });

  it("changes only the worker model's thinking when given a level alone", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => instance.models.settings.set("worker", { provider: "workers-ai", modelId: KIMI, thinkingLevel: "off" }));
    await answered(name, "thinker", "reply: done", { thinking: "high" });

    expect(await requestsOf(name, "thinker")).toEqual([{ model: KIMI, reasoning: "high" }]);
  });

  it("runs a kept model's next send on the worker model once its provider is gone, and keeps it", async () => {
    const name = crypto.randomUUID();
    expect(await connectOpenCode(name)).toEqual({});
    await answered(name, "keeper", "reply: done", { model: `${FLASH.provider}/${FLASH.modelId}` });
    expect((await modelsOf(name, "keeper")).at(-1)).not.toBe(GLM);

    await inside(name, (instance) => instance.models.removeKey("opencode-go"));
    expect(await subagent(name, { action: "send", name: "keeper", message: "reply: again" })).toBe("tool said: Sent to keeper.");
    await settled(name, "keeper", ["done", "done"]);

    expect((await modelsOf(name, "keeper")).at(-1)).toBe(GLM);
    expect(await kept(name, "keeper")).toMatchObject(FLASH);
  });

  it("starts a subagent given a level alone while the worker's provider is down", async () => {
    const name = crypto.randomUUID();
    expect(await connectOpenCode(name)).toEqual({});
    // The key puts every purpose on OpenCode Go; the main agent goes back to Workers AI, to answer while it is down.
    await inside(name, (instance) => {
      instance.models.settings.set("worker", { ...FLASH, thinkingLevel: "off" });
      instance.models.settings.set("main", { provider: "workers-ai", modelId: GLM, thinkingLevel: "off" });

      return instance.applyMain();
    });
    await agent(name).provider("opencode-go", false);

    expect(await subagent(name, { action: "spawn", name: "thinker", message: "reply: done", thinking: "high" })).toBe(
      "tool said: Started thinker."
    );
  });

  it("refuses a followUp send that names a model while the subagent is busy", async () => {
    const name = crypto.randomUUID();
    expect(await prompt(name, "spawn busy gate").then((result) => result.text)).toBe("tool said: Started busy.");
    await gateStarted(name, 1);

    expect(await subagent(name, { action: "send", name: "busy", message: "reply: later", followUp: true, model: `workers-ai/${KIMI}` })).toBe(
      "tool said: busy is busy: a followUp send can't change its model. Send it without followUp, or once it answers."
    );
    expect(await kept(name, "busy")).toBeUndefined();
  });

  it("refuses an unknown model, naming the choices, and starts nothing", async () => {
    const name = crypto.randomUUID();

    expect(await subagent(name, { action: "spawn", name: "lost", message: "reply: hi", model: "nowhere/some-model" })).toMatch(
      /^tool said: No connected model nowhere\/some-model\. Choose one of: workers-ai\//
    );
    expect(await subagent(name, { action: "status" })).toBe("tool said: No subagents.");
    expect(await tasks(name)).toEqual([]);
  });
});
