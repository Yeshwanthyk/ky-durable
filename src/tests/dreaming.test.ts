import { describe, expect, it } from "vitest";
import {
  DREAM_MEMORY_TOOLS,
  DREAMING_TABLES,
  dreamingTools,
  Memory,
  MEMORY_WRITE_TOOLS,
  Soul,
  SOUL_EDIT
} from "../dreaming/contract";
import { inside, prompt } from "./drive";

/**
 * Dreaming's invariants that need a Durable Object; the pure ones are in test/invariants/dreaming.test.ts.
 * A restore copies cells as the archive held them, so a cell may come back the wrong type: each read
 * here meets one and carries on.
 */

const never = () => Promise.reject(new Error("no summaries in this test"));

describe("dreaming's contract", () => {
  it("allowlists only tools the domain registers", async () => {
    const names = await inside(crypto.randomUUID(), (instance) => {
      const { soul, memory } = dreamingTools({ soul: instance.soul, memory: instance.memory, history: instance.history, reviews: instance.reviews, chat: () => true });

      return [...(soul.tools ?? []), ...(memory.tools ?? [])].map((tool) => tool.name);
    });

    expect([...MEMORY_WRITE_TOOLS, ...DREAM_MEMORY_TOOLS, SOUL_EDIT].filter((name) => !names.includes(name))).toEqual([]);
  });

  it("creates its tables on start, and a second start keeps them and their rows", async () => {
    const name = crypto.randomUUID();
    await prompt(name, "hello");

    const [tables, count, soul] = await inside(name, (instance, state) => {
      instance.memory.note("the user likes green tea");
      new Memory(state.storage.sql, never);
      const again = new Soul(state.storage.sql);
      const listed = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => row.name);

      return [listed, new Memory(state.storage.sql, never).count(), again.current().action];
    });

    expect(Object.values(DREAMING_TABLES).filter((table) => !tables.includes(table))).toEqual([]);
    expect(count).toBe(1);
    expect(soul).toBe("create");
  });
});

describe("a damaged row after a restore", () => {
  it("leaves the dream's mark at the beginning, so the next dream reads everything", async () => {
    const mark = await inside(crypto.randomUUID(), (instance, state) => {
      state.storage.sql.exec("INSERT INTO ky_dream (id, memories, at) VALUES (1, 'twelve', 0)");

      return instance.dreaming.mark();
    });

    expect(mark).toEqual({ memories: 0, at: 0 });
  });

  it("is left out of memory's view, recall and search", async () => {
    const [view, recall, search] = await inside(crypto.randomUUID(), (instance, state) => {
      instance.memory.note("the user likes green tea");
      state.storage.sql.exec("INSERT INTO memo_log (id, date, text) VALUES (1, X'00', 'the user likes oolong')");

      return [instance.memory.view(), instance.memory.recall("the user"), instance.memory.search("the user")];
    });

    expect(view.count).toBe(2);
    // The newest memory is the damaged one, so the panel shows no date for it.
    expect(view).toMatchObject({ newest: null, items: [{ kind: "memory", id: 0, text: "the user likes green tea" }] });
    expect(recall).toMatch(/^#0 \d{4}-\d{2}-\d{2} the user likes green tea\n1 match\.$/);
    expect(search).toMatchObject({ total: 1, matches: [{ id: 0 }] });
  });

  it("hides a damaged SOUL.md version behind the last good one", async () => {
    const [current, history] = await inside(crypto.randomUUID(), (instance, state) => {
      instance.soul.apply({ action: "edit", body: "# SOUL.md\nBe brief." }, "user");
      state.storage.sql.exec(
        "INSERT INTO ky_soul_versions (key, version, action, actor, conversation, body, created_at) VALUES ('soul', 3, 'edit', 'user', NULL, 'lost', 'never')"
      );

      return [instance.soul.current().body, instance.soul.history().map((each) => each.id)];
    });

    expect(current).toBe("# SOUL.md\nBe brief.");
    expect(history).toEqual([2, 1]);
  });
});
