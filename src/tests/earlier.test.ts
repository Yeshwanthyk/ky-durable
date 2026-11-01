import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentEvent, ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { COMPACTION } from "../core/transcript";
import { earlierPage } from "../earlier";
import { buildTurns } from "../ui/turns";
import { EMPTY_VIEW, reduceEvents, withEarlier, type PiSessionView } from "../view";
import { ANSWERS } from "../server-frames";
import { decode } from "../core/decode";
import { browser, inside, prompt } from "./drive";

/**
 * A compaction leaves the chat before its head out of the model's context, and so out of the snapshot; pi keeps it.
 * The chat shows a divider where the context starts again and pages back through what came before, as far as the
 * user scrolls.
 */

// SAFETY: pi's ids are numbers branded by kind; these stand in for ones pi made.
const conversationId = 1 as ConversationId;

// SAFETY: as above.
const entryId = (id: number) => id as EntryId;

const user = (id: number, text: string): EntryRecord => ({
  id: entryId(id),
  conversationId,
  kind: "pi.user",
  model: [{ role: "user", content: [{ type: "text", text }], timestamp: id * 1000 }]
});

const reply = (id: number, text: string): EntryRecord => ({
  id: entryId(id),
  conversationId,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: id * 1000
    }
  ]
});

const compaction = (id: number, head: number, summary: string): EntryRecord => ({
  id: entryId(id),
  conversationId,
  kind: COMPACTION,
  head: entryId(head),
  model: [{ role: "user", content: [{ type: "text", text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>` }], timestamp: id * 1000 }]
});

const reset = (id: number): EntryRecord => ({ id: entryId(id), conversationId, kind: "pi.reset", head: entryId(id) });

/** Turns of `count` user messages and their replies, ids from `from`. */
function chat(from: number, count: number): EntryRecord[] {
  return Array.from({ length: count }, (_, index) => [user(from + index * 2, `ask ${from + index * 2}`), reply(from + index * 2 + 1, `answer ${from + index * 2 + 1}`)]).flat();
}

function snapshot(entries: readonly EntryRecord[]): AgentEvent {
  // SAFETY: the reducer reads only these of a snapshot.
  return { type: "snapshot", entries, inbox: [], tools: [], agent: {} } as never;
}

const appended = (entry: EntryRecord): AgentEvent => ({ type: "entry_appended", entry });

const asked = (view: PiSessionView) => [...view.earlier, ...view.messages].flatMap((message) => (message.role === "user" ? [message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")] : []));

describe("the chat before a compaction", () => {
  it("snapshots with the summary first and pages back from its head", () => {
    const view = reduceEvents(EMPTY_VIEW, [snapshot([compaction(50, 20, "We talked about KV caches."), ...chat(20, 3)])]);

    expect(view.boundary).toBe(20);
    expect(view.before).toBe(20);
    expect(view.earlier).toEqual([]);
    expect(view.messages[0]).toMatchObject({ role: "notice", boundary: "summary", parts: [{ type: "text", text: "We talked about KV caches." }] });

    const first = withEarlier(view, 20, { entries: chat(10, 5), more: true });

    expect(first.before).toBe(10);
    expect(asked(first)).toEqual(["ask 10", "ask 12", "ask 14", "ask 16", "ask 18", "ask 20", "ask 22", "ask 24"]);

    const all = withEarlier(first, 10, { entries: chat(2, 4), more: false });

    expect(all.before).toBeNull();
    expect(asked(all)[0]).toBe("ask 2");
    // A page for a cursor already passed changes nothing.
    expect(withEarlier(all, 20, { entries: chat(10, 5), more: true })).toBe(all);
  });

  it("keeps what the user paged back to across a resync of the same context, and starts over after a new one", () => {
    const entries = [compaction(50, 20, "s"), ...chat(20, 3)];
    const paged = withEarlier(reduceEvents(EMPTY_VIEW, [snapshot(entries)]), 20, { entries: chat(10, 5), more: true });

    expect(reduceEvents(paged, [snapshot(entries)]).earlier).toBe(paged.earlier);

    const next = reduceEvents(paged, [snapshot([compaction(80, 24, "t"), ...chat(24, 1)])]);

    expect(next.earlier).toEqual([]);
    expect(next.before).toBe(24);
  });

  it("moves what a live compaction cut into the chat before it, rather than dropping it", () => {
    const live = reduceEvents(EMPTY_VIEW, [snapshot(chat(2, 6)), appended(compaction(14, 10, "Earlier on"))]);

    expect(live.boundary).toBe(10);
    // Nothing was cut before this one, so the chat's start is already here.
    expect(live.before).toBeNull();
    expect(asked(live)).toEqual(["ask 2", "ask 4", "ask 6", "ask 8", "ask 10", "ask 12"]);
    expect(live.messages.map((message) => message.id)).toEqual(["14", "10", "11", "12", "13"]);
  });

  it("keeps the chat before a reset", () => {
    const view = reduceEvents(EMPTY_VIEW, [snapshot(chat(2, 2)), appended(reset(6)), appended(user(7, "fresh"))]);

    expect(asked(view)).toEqual(["ask 2", "ask 4", "fresh"]);
    expect(view.messages[0]).toMatchObject({ role: "notice", boundary: "reset" });
  });

  it("opens the turn after the summary under a divider, and names turns by message so a page above leaves them be", () => {
    const view = reduceEvents(EMPTY_VIEW, [snapshot([compaction(50, 21, "s"), ...chat(20, 3).slice(1)])]);
    const turns = buildTurns(view.messages, null, false, []);

    expect(turns[0]).toMatchObject({ id: "21:turn", divider: "summary", summary: "s", user: "" });

    const paged = withEarlier(view, 21, { entries: chat(10, 5).concat(user(20, "ask 20")), more: false });
    const after = buildTurns([...paged.earlier, ...paged.messages], null, false, []);

    expect(after.map((turn) => turn.id).slice(-3)).toEqual(turns.map((turn) => turn.id));
    expect(after[0]?.divider).toBeUndefined();
  });
});

describe("the earlier ask", () => {
  it("pages from a compaction's head back to the chat's first message", async () => {
    const name = crypto.randomUUID();

    for (const text of ["one", "two", "three", "four"]) await prompt(name, text);

    await inside(name, async (instance) => {
      const conversation = await instance.harness.conversation(ROOT_SESSION);
      const { items } = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
      const four = items.find((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes('"four"'));

      if (four === undefined) throw new Error("no fourth message");
      await conversation.submit(
        { type: "write", entry: { kind: COMPACTION, head: four.id, model: [{ role: "user", content: [{ type: "text", text: "<summary>\nOne to three.\n</summary>" }], timestamp: Date.now() }] }, requestId: "compact" },
        BACKGROUND_CONTEXT
      );
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
    });

    const tab = await browser(name);
    await tab.until(() => tab.view().boundary !== null);
    const view = tab.view();

    expect(asked(view)).toEqual(["four"]);
    expect(view.before).not.toBeNull();

    const answer = await tab.send({ type: "earlier", before: view.before ?? 0 });

    if (answer?.type !== "result") throw new Error(`no page: ${JSON.stringify(answer)}`);
    const page = decode(ANSWERS.earlier, answer.result, "the earlier page");

    expect(page.more).toBe(false);
    expect(page.entries.some((entry) => entry.kind === "pi.system")).toBe(false);
    expect(asked(withEarlier(view, view.before ?? 0, page))).toEqual(["one", "two", "three", "four"]);
    tab.close();
  });

  it("stops a page at its size and says there is more", async () => {
    const entries = chat(2, 100).reverse();

    const conversation = {
      entries: async (query: { maxEntryId?: EntryId }, limit: number, cursor: number | undefined) => {
        const from = cursor ?? 0;
        const below = entries.filter((entry) => entry.id <= (query.maxEntryId ?? Infinity));
        const items = below.slice(from, from + limit);

        return { items, next: from + limit < below.length ? from + limit : undefined };
      }
    };

    // SAFETY: the fake answers the one call earlierPage makes.
    const page = await earlierPage(conversation as never, 202, BACKGROUND_CONTEXT);

    expect(page.entries).toHaveLength(120);
    expect(page.more).toBe(true);
    expect(Number(page.entries.at(-1)?.id)).toBe(201);
    expect(Number(page.entries[0]?.id)).toBe(82);
  });
});
