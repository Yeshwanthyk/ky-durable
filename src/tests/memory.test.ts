import { fauxAssistantMessage, fauxText, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type Compressor, Memory, type MemoryItem } from "../dreaming/contract";
import { inside } from "./drive";

/** The memory panel's view of OptMem, on ky's real PiAgent: wake's blocks, zoom's halves, recall's search, forget. */

/** A summary writer like the faux model's: "memory 0 to memory 7" for the notes 0 to 7. */
const writer: Compressor = async (_system, messages) => {
  const lines = textIn(messages[0]).split("\n");
  const items = lines.slice(lines.findIndex((line) => /^(Compress|Merge) these/.test(line)) + 1).map((line) => line.split(" to "));

  return fauxAssistantMessage([fauxText(`${items[0]?.[0]} to ${items.at(-1)?.at(-1)}`)]);
};

/** A user message's text, its parts joined by newlines. */
function textIn(message: Message | undefined): string {
  if (message?.role !== "user") return "";

  return Array.isArray(message.content)
    ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
    : message.content;
}

/** Memory on the agent's storage, with the quick writer, holding `count` memories, "memory 0" on, every summary written. */
async function filled(state: DurableObjectState, count: number): Promise<Memory> {
  const memory = new Memory(state.storage.sql, writer);

  for (let i = 0; i < count; i++) memory.note(`memory ${i}`);
  await memory.compress();

  return memory;
}

/** The memories an item stands for. */
const size = (item: MemoryItem) => {
  if (item.kind === "memory") return 1;
  const [lo = 0, hi = 0] = item.block.split("-").map(Number);

  return hi - lo + 1;
};

const today = () => new Date().toISOString().slice(0, 10);

describe("memory panel", () => {
  it("shows nothing before the first memory", async () => {
    const view = await inside(crypto.randomUUID(), (instance) => instance.memory.view());

    expect(view).toEqual({ count: 0, newest: null, items: [] });
  });

  it("shows recent memories as written and older ones as summaries, newest first", async () => {
    const view = await inside(crypto.randomUUID(), async (_instance, state) => (await filled(state, 200)).view());

    expect(view.count).toBe(200);
    expect(view.newest).toBe(today());
    expect(view.items[0]).toEqual({ kind: "memory", id: 199, date: today(), text: "memory 199" });
    expect(view.items.length).toBeLessThanOrEqual(64);

    // Every memory is in exactly one item, and the oldest is a summarized block.
    expect(view.items.reduce((sum, item) => sum + size(item), 0)).toBe(200);
    expect(view.items.at(-1)).toMatchObject({ kind: "block", block: "0-7", text: "memory 0 to memory 7", from: today() });
  });

  it("opens a block into its two halves, newest first, down to memories", async () => {
    const [halves, pair, zoom] = await inside(crypto.randomUUID(), async (_instance, state) => {
      const memory = await filled(state, 40);

      return [memory.children("0-31"), memory.children("0-1"), memory.zoom("0-31")] as const;
    });

    expect(halves).toMatchObject([
      { kind: "block", block: "16-31", text: "memory 16 to memory 31" },
      { kind: "block", block: "0-15", text: "memory 0 to memory 15" }
    ]);
    expect(pair).toMatchObject([
      { kind: "memory", id: 1, text: "memory 1" },
      { kind: "memory", id: 0, text: "memory 0" }
    ]);
    // memory_zoom reads the same halves, oldest first, as before.
    expect(zoom).toBe("#0-15 memory 0 to memory 15\n#16-31 memory 16 to memory 31");
  });

  it("searches like memory_recall, and as plain text when the query is no regex", async () => {
    const [regex, plain, recall] = await inside(crypto.randomUUID(), async (_instance, state) => {
      const memory = await filled(state, 30);
      memory.note("the user likes (green) tea");

      let error = "";

      try {
        memory.recall("(green");
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      return [memory.search("MEMORY 2\\d$"), memory.search("(green"), error] as const;
    });

    expect(regex).toMatchObject({ total: 10, regex: true });
    expect(regex.matches.map((row) => row.id)).toEqual([29, 28, 27, 26, 25, 24, 23, 22, 21, 20]);
    expect(plain).toMatchObject({ total: 1, regex: false, matches: [{ id: 30, text: "the user likes (green) tea" }] });
    // memory_recall itself still refuses a bad regex.
    expect(recall).toMatch(/^Bad regex/);
  });

  it("returns at most the newest 50 matches, with the total", async () => {
    const found = await inside(crypto.randomUUID(), async (_instance, state) => (await filled(state, 70)).search("memory"));

    expect(found.total).toBe(70);
    expect(found.matches).toHaveLength(50);
    expect(found.matches[0]?.id).toBe(69);
  });

  it("rebuilds a summary by forgetting it and those above it, and says so", async () => {
    const [changes, halves, refused] = await inside(crypto.randomUUID(), async (_instance, state) => {
      const memory = await filled(state, 32);
      let count = 0;
      memory.onChange(() => count++);
      memory.forget("0-1");
      memory.note("one more");

      let error = "";

      try {
        memory.forget("0-1");
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      return [count, memory.children("0-3"), error] as const;
    });

    // The forget and the note changed it; the refused forget did not.
    expect(changes).toBe(2);
    expect(halves).toMatchObject([
      { kind: "block", block: "2-3", text: "memory 2 to memory 3" },
      { kind: "block", block: "0-1", text: null }
    ]);
    expect(refused).toBe("No summary at 0-1.");
  });

  it("asks again when a summary is over 280 bytes, showing where it must end, and keeps the shortest try", async () => {
    const [asks, summary] = await inside(crypto.randomUUID(), async (_instance, state) => {
      const asks: string[] = [];
      const answers = ["x".repeat(400), "y".repeat(300), "z".repeat(350), "w".repeat(320)];

      const memory = new Memory(state.storage.sql, async (_system, messages) => {
        asks.push(textIn(messages.at(-1)));

        return fauxAssistantMessage([fauxText(answers[asks.length - 1] ?? "")]);
      });

      memory.note("first");
      memory.note("second");
      await memory.compress();

      return [asks, memory.children("0-1")] as const;
    });

    // Four tries at most, each retry told the size and shown the cut.
    expect(asks).toHaveLength(4);
    expect(asks[1]).toMatch(/^That line is 400 bytes; the limit is 280\. It must end where it is cut here:\nx{280}\| ← LIMIT$/);
    expect(summary).toMatchObject([{ text: "second" }, { text: "first" }]);
  });

  it("saves the shortest try as the summary", async () => {
    const saved = await inside(crypto.randomUUID(), async (_instance, state) => {
      let calls = 0;
      const answers = ["x".repeat(400), "y".repeat(300), "z".repeat(350), "w".repeat(320)];

      const memory = new Memory(
        state.storage.sql,
        async () => fauxAssistantMessage([fauxText(answers[calls++] ?? "")])
      );

      memory.note("first");
      memory.note("second");
      await memory.compress();

      return tree(state);
    });

    expect(saved).toEqual([{ lo: 0, hi: 2, text: "y".repeat(300) }]);
  });

  it("stops at a failed summary and writes it on the next call", async () => {
    const [before, after] = await inside(crypto.randomUUID(), async (_instance, state) => {
      let down = true;

      const memory = new Memory(state.storage.sql, async (system, messages) => {
        if (down) throw new Error("model down");

        return writer(system, messages);
      });

      for (let i = 0; i < 4; i++) memory.note(`memory ${i}`);
      await memory.compress();
      const before = tree(state);
      down = false;
      await memory.compress();

      return [before, tree(state)] as const;
    });

    expect(before).toEqual([]);
    expect(after).toEqual([
      { lo: 0, hi: 2, text: "memory 0 to memory 1" },
      { lo: 0, hi: 4, text: "memory 0 to memory 3" },
      { lo: 2, hi: 4, text: "memory 2 to memory 3" }
    ]);
  });

  it("gives the writer the older memory as context, and no block ids", async () => {
    const asked = await inside(crypto.randomUUID(), async (_instance, state) => {
      const memory = await filled(state, 18);
      const asked: string[] = [];

      const spy = new Memory(state.storage.sql, async (system, messages) => {
        asked.push(textIn(messages[0]));

        return writer(system, messages);
      });

      memory.forget("16-17");
      await spy.compress();

      return asked;
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^<memory>\n\d{4}-\d\d-\d\d memory 0\n/);
    expect(asked[0]).toContain("memory 15\n</memory>");
    expect(asked[0]).toMatch(/Compress these 2 notes, from \d{4}-\d\d-\d\d, into one line, in at most 280 bytes:\nmemory 16\nmemory 17$/);
    expect(asked[0]).not.toMatch(/#\d/);
  });
});

/** Every summary written, by block. */
function tree(state: DurableObjectState): Array<{ lo: number; hi: number; text: string }> {
  return state.storage.sql
    .exec<{ lo: number; hi: number; text: string }>("SELECT lo, hi, text FROM memo_tree ORDER BY lo, hi")
    .toArray();
}
