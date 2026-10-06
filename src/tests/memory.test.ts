import { describe, expect, it } from "vitest";
import type { Memory, MemoryItem } from "../memory";
import { inside } from "./drive";

/** The memory panel's view of OptMem, on ky's real PiAgent: wake's blocks, zoom's halves, recall's search, forget. */

/** Notes `count` memories, "memory 0" on, writing each summary the notes ask for, as the agent would. */
function fill(memory: Memory, count: number): void {
  for (let i = 0; i < count; i++) {
    let owed = memory.note(`memory ${i}`);
    let block = /memory_nap with block "(\d+-\d+)"/.exec(owed)?.[1];

    while (block !== undefined) {
      owed = memory.nap(block, `summary of ${block}`);
      block = /memory_nap with block "(\d+-\d+)"/.exec(owed)?.[1];
    }
  }
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
    const view = await inside(crypto.randomUUID(), (instance) => {
      fill(instance.memory, 200);

      return instance.memory.view();
    });

    expect(view.count).toBe(200);
    expect(view.newest).toBe(today());
    expect(view.items[0]).toEqual({ kind: "memory", id: 199, date: today(), text: "memory 199" });
    expect(view.items.length).toBeLessThanOrEqual(64);

    // Every memory is in exactly one item, and the oldest is a summarized block.
    expect(view.items.reduce((sum, item) => sum + size(item), 0)).toBe(200);
    expect(view.items.at(-1)).toMatchObject({ kind: "block", block: "0-7", text: "summary of 0-7", from: today() });
  });

  it("opens a block into its two halves, newest first, down to memories", async () => {
    const [halves, pair, zoom] = await inside(crypto.randomUUID(), (instance) => {
      fill(instance.memory, 40);

      return [instance.memory.children("0-31"), instance.memory.children("0-1"), instance.memory.zoom("0-31")] as const;
    });

    expect(halves).toMatchObject([
      { kind: "block", block: "16-31", text: "summary of 16-31" },
      { kind: "block", block: "0-15", text: "summary of 0-15" }
    ]);
    expect(pair).toMatchObject([
      { kind: "memory", id: 1, text: "memory 1" },
      { kind: "memory", id: 0, text: "memory 0" }
    ]);
    // memory_zoom reads the same halves, oldest first, as before.
    expect(zoom).toBe("#0-15 summary of 0-15\n#16-31 summary of 16-31");
  });

  it("searches like memory_recall, and as plain text when the query is no regex", async () => {
    const [regex, plain, recall] = await inside(crypto.randomUUID(), (instance) => {
      fill(instance.memory, 30);
      instance.memory.note("the user likes (green) tea");

      let error = "";

      try {
        instance.memory.recall("(green");
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      return [instance.memory.search("MEMORY 2\\d$"), instance.memory.search("(green"), error] as const;
    });

    expect(regex).toMatchObject({ total: 10, regex: true });
    expect(regex.matches.map((row) => row.id)).toEqual([29, 28, 27, 26, 25, 24, 23, 22, 21, 20]);
    expect(plain).toMatchObject({ total: 1, regex: false, matches: [{ id: 30, text: "the user likes (green) tea" }] });
    // memory_recall itself still refuses a bad regex.
    expect(recall).toMatch(/^Bad regex/);
  });

  it("returns at most the newest 50 matches, with the total", async () => {
    const found = await inside(crypto.randomUUID(), (instance) => {
      fill(instance.memory, 70);

      return instance.memory.search("memory");
    });

    expect(found.total).toBe(70);
    expect(found.matches).toHaveLength(50);
    expect(found.matches[0]?.id).toBe(69);
  });

  it("rebuilds a summary by forgetting it and those above it, and says so", async () => {
    const [changes, halves, refused] = await inside(crypto.randomUUID(), (instance) => {
      fill(instance.memory, 32);
      let count = 0;
      instance.memory.onChange(() => count++);
      instance.memory.forget("0-1");
      instance.memory.note("one more");

      let error = "";

      try {
        instance.memory.forget("0-1");
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      return [count, instance.memory.children("0-3"), error] as const;
    });

    // The forget and the note changed it; the refused forget did not.
    expect(changes).toBe(2);
    expect(halves).toMatchObject([
      { kind: "block", block: "2-3", text: "summary of 2-3" },
      { kind: "block", block: "0-1", text: null }
    ]);
    expect(refused).toBe("No summary at 0-1.");
  });
});
