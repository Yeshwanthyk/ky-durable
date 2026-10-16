import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { inside, prompt } from "./drive";

/** What keeps a dream's changes safe, on ky's real PiAgent: pins, provenance, merges, the stale pass, and the ledger's undo. */

const DAY = 24 * 60 * 60 * 1000;

const tool = (name: string, args: Record<string, JsonValue>) => `tool ${name} ${JSON.stringify(args)}`;

const skill = (name: string, body = "1. Open the list.\n2. Order oat milk.") =>
  tool("skill_manage", { action: "create", name, description: `How to do ${name}`, body });

/** A ky with two skills the agent made and a memory, after one dream; `said` prompts that dream's session. */
async function dreamt(name: string) {
  await inside(name, (instance) => {
    instance.skills.reviewAfter = 99;
  });
  await prompt(name, tool("memory_note", { text: "the user likes green tea" }));
  await prompt(name, skill("weekly-groceries"));
  await prompt(name, skill("grocery-run"));
  await inside(name, (instance) => instance.dreaming.run());

  const session = await inside(name, (instance) => instance.feed.list().find((task) => task.worker === "dreaming")?.session);
  expect(session).toBeDefined();

  return (text: string) => inside(name, async (instance) => (await instance.harness.session(session!).prompt(text)).text);
}

const body = (name: string, skillName: string) => inside(name, (instance) => instance.skills.get(skillName)?.body);

const ledger = (name: string) => inside(name, (instance) => instance.ledger.lastNight());

describe("a dream's skill changes", () => {
  it("archives a skill only as a merge into an active one", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);

    expect(await said(tool("skill_manage", { action: "archive", name: "grocery-run" }))).toContain("give absorbed_into");
    expect(await said(tool("skill_manage", { action: "archive", name: "grocery-run", absorbed_into: "no-such-skill" }))).toContain("give absorbed_into");
    expect(await said(tool("skill_manage", { action: "archive", name: "grocery-run", absorbed_into: "grocery-run" }))).toContain("give absorbed_into");
    expect(await inside(name, (instance) => instance.skills.get("grocery-run")?.status)).toBe("active");

    expect(await said(tool("skill_manage", { action: "archive", name: "grocery-run", absorbed_into: "weekly-groceries", reason: "same task" }))).toContain(
      "Saved archive of grocery-run"
    );
    expect(await ledger(name)).toMatchObject([
      { kind: "skill", action: "archive", target: "grocery-run", absorbed_into: "weekly-groceries", reason: "same task", undone_at: null }
    ]);
  });

  it("leaves a pinned skill as it is, and never archives the user's own", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);
    expect(await prompt(name, tool("skill_manage", { action: "pin", name: "weekly-groceries" }))).toMatchObject({
      text: "tool said: Pinned weekly-groceries: a dream leaves it as it is."
    });

    expect(await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" }))).toContain("is pinned");
    expect(await said(tool("skill_manage", { action: "archive", name: "weekly-groceries", absorbed_into: "grocery-run" }))).toContain("is pinned");
    expect(await said(tool("skill_manage", { action: "unpin", name: "weekly-groceries" }))).toContain("Only the user pins");
    expect(await body(name, "weekly-groceries")).toContain("oat milk");

    await inside(name, (instance) =>
      instance.skills.apply({ action: "create", name: "my-routine", description: "The user's own", body: "Mine." }, "user")
    );
    expect(await said(tool("skill_manage", { action: "archive", name: "my-routine", absorbed_into: "grocery-run" }))).toContain("the user's own skill");
    expect(await inside(name, (instance) => instance.skills.get("my-routine"))).toMatchObject({ status: "active", created_by: "user" });
    expect(await ledger(name)).toEqual([]);
  });

  it("makes at most one destructive change to a skill a run, and records each change", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);

    expect(await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" }))).toContain("Saved patch");
    expect(await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "soy milk", new: "rice milk" }))).toContain(
      "This dream already changed weekly-groceries"
    );
    expect(await body(name, "weekly-groceries")).toContain("soy milk");
    expect(await said(skill("tea-order"))).toContain("Created tea-order");

    const rows = await ledger(name);
    expect(rows).toMatchObject([
      { kind: "skill", action: "patch", target: "weekly-groceries" },
      { kind: "skill", action: "create", target: "tea-order", before: null }
    ]);
    expect(new Set(rows.map((row) => row.run)).size).toBe(1);
  });
});

describe("the stale pass", () => {
  it("archives a skill ky made and nobody opened in 61 days, leaving the user's and pinned ones", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      for (const each of ["unused", "pinned", "opened"]) {
        instance.skills.apply({ action: "create", name: each, description: each, body: "Steps." }, "agent");
      }

      instance.skills.apply({ action: "create", name: "users", description: "users", body: "Steps." }, "user");
      instance.skills.apply({ action: "pin", name: "pinned" }, "user");
    });

    // Too young to be stale yet.
    expect(await inside(name, (instance) => instance.skills.stale(Date.now() + 10 * DAY))).toEqual([]);

    const archived = await inside(name, (instance) => {
      instance.skills.view("opened");

      return instance.skills.stale(Date.now() + 61 * DAY);
    });

    // "opened" was used just now, so 61 days on it is 61 days unused too; one opened later stays.
    expect(archived.sort()).toEqual(["opened", "unused"]);
    expect(await inside(name, (instance) => instance.skills.stale(Date.now() + 61 * DAY))).toEqual([]);
    expect(await inside(name, (instance) => instance.skills.list().map((each) => each.name))).toEqual(["pinned", "users"]);
    const rows = await ledger(name);
    expect(rows).toMatchObject([
      { kind: "skill", action: "archive", reason: "Not used in 60 days" },
      { kind: "skill", action: "archive", reason: "Not used in 60 days" }
    ]);
    expect(rows[0]?.run).toMatch(/^stale-\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps a skill opened lately, and one whose archive the user undid", async () => {
    const name = crypto.randomUUID();

    const archived = await inside(name, (instance) => {
      instance.skills.apply({ action: "create", name: "kept", description: "kept", body: "Steps." }, "agent");

      return instance.skills.stale(Date.now() + 61 * DAY);
    });

    expect(archived).toEqual(["kept"]);

    const [row] = await ledger(name);
    await inside(name, (instance) => instance.ledger.undo(row!.id));
    expect(await inside(name, (instance) => instance.skills.get("kept")?.status)).toBe("active");
    // The undo is the user's change, so the next pass counts from it.
    expect(await inside(name, (instance) => instance.skills.stale(Date.now() + 30 * DAY))).toEqual([]);
  });
});

describe("undo", () => {
  it("puts a skill back to the version before the dream's change, once", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);
    await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" }));
    await said(tool("skill_manage", { action: "archive", name: "grocery-run", absorbed_into: "weekly-groceries" }));

    const [patch, archive] = await ledger(name);
    expect(await inside(name, (instance) => instance.ledger.undo(patch!.id))).toContain("Saved revert of weekly-groceries");
    expect(await body(name, "weekly-groceries")).toContain("oat milk");
    await inside(name, (instance) => instance.ledger.undo(archive!.id));
    expect(await inside(name, (instance) => instance.skills.get("grocery-run")?.status)).toBe("active");

    expect(await inside(name, (instance) => instance.skills.history("weekly-groceries")[0])).toMatchObject({ action: "revert", actor: "user" });
    expect((await ledger(name)).every((row) => row.undone_at !== null)).toBe(true);
    await expect(inside(name, (instance) => instance.ledger.undo(patch!.id))).rejects.toThrow("already undone");
  });

  it("notes a forgotten summary again as a new memory, leaving the log as it was", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);
    await inside(name, (instance, state) => {
      instance.memory.note("the user switched to oolong");
      state.storage.sql.exec("INSERT OR REPLACE INTO memo_tree (lo, hi, text) VALUES (0, 2, 'the user drinks green tea, then oolong')");
    });
    const before = await inside(name, (instance) => instance.memory.count());

    expect(await said(tool("memory_forget", { block: "0-1" }))).toContain("Forgot");
    // Rewritten in the background or not, the same dream may not drop it again.
    await inside(name, (_instance, state) => {
      state.storage.sql.exec("INSERT OR REPLACE INTO memo_tree (lo, hi, text) VALUES (0, 2, 'rewritten')");
    });
    expect(await said(tool("memory_forget", { block: "0-1" }))).toContain("This dream already changed 0-1");
    const [forget] = await ledger(name);
    expect(forget).toMatchObject({ kind: "memory", action: "forget", target: "0-1", before: "the user drinks green tea, then oolong" });

    expect(await inside(name, (instance) => instance.ledger.undo(forget!.id))).toBe(`Saved as #${before}.`);
    expect(await inside(name, (instance) => instance.memory.recall("then oolong"))).toContain("the user drinks green tea, then oolong");
    expect(await inside(name, (instance) => instance.memory.count())).toBe(before + 1);
  });

  it("records no forget by the user or the agent", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance, state) => {
      instance.memory.note("a");
      instance.memory.note("b");
      state.storage.sql.exec("INSERT OR REPLACE INTO memo_tree (lo, hi, text) VALUES (0, 2, 'a and b')");
      instance.memory.forget("0-1");
    });
    expect(await ledger(name)).toEqual([]);
  });
});
