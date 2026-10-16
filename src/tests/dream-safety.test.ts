import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Skills } from "../skills/skills";
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
      text: "tool said: Pinned weekly-groceries: ky's dreams and reviews leave it as it is."
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

  it("may not archive by reverting to an archived version, unless as a merge", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);

    const archived = await inside(name, (instance) => {
      instance.skills.apply({ action: "archive", name: "grocery-run" }, "user");
      instance.skills.apply({ action: "restore", name: "grocery-run" }, "user");

      return instance.skills.history("grocery-run").find((each) => each.action === "archive")!.id;
    });

    expect(await said(tool("skill_manage", { action: "revert", name: "grocery-run", version: archived }))).toContain("give absorbed_into");
    expect(await inside(name, (instance) => instance.skills.get("grocery-run")?.status)).toBe("active");
    expect(await ledger(name)).toEqual([]);

    expect(await said(tool("skill_manage", { action: "revert", name: "grocery-run", version: archived, absorbed_into: "weekly-groceries" }))).toContain(
      "Saved revert of grocery-run"
    );
    expect(await inside(name, (instance) => instance.skills.get("grocery-run")?.status)).toBe("archived");
  });

  it("makes at most one destructive change to a skill a run, and records each change", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);

    expect(await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" }))).toContain("Saved patch");
    expect(await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "soy milk", new: "rice milk" }))).toContain(
      "This run already changed weekly-groceries"
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

describe("a skill review's changes", () => {
  /** A review fork of the main chat, as a busy turn makes one; `said` prompts it. */
  async function reviewing(name: string) {
    const session = await inside(name, async (instance) => {
      const { id } = await instance.harness.sessions.create();
      instance.reviews.add(id, "", "review");

      return id;
    });

    return { session, said: (text: string) => inside(name, async (instance) => (await instance.harness.session(session).prompt(text)).text) };
  }

  it("leaves a pinned skill and the user's own as they are, like a dream", async () => {
    const name = crypto.randomUUID();
    await dreamt(name);
    await inside(name, (instance) => {
      instance.skills.apply({ action: "pin", name: "weekly-groceries" }, "user");
      instance.skills.apply({ action: "create", name: "my-routine", description: "The user's own", body: "Mine." }, "user");
    });
    const { said } = await reviewing(name);

    expect(await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" }))).toContain("is pinned");
    expect(await said(tool("skill_manage", { action: "archive", name: "my-routine", absorbed_into: "grocery-run" }))).toContain("the user's own skill");
    expect(await said(tool("skill_manage", { action: "pin", name: "grocery-run" }))).toContain("Only the user pins");
    expect(await body(name, "weekly-groceries")).toContain("oat milk");
    expect(await inside(name, (instance) => instance.skills.get("my-routine")?.status)).toBe("active");
  });

  it("is recorded under the review's own run, apart from last night, and can be undone", async () => {
    const name = crypto.randomUUID();
    await dreamt(name);
    const { session, said } = await reviewing(name);

    expect(await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" }))).toContain("Saved patch");
    const rows = await inside(name, (_instance, state) => state.storage.sql.exec("SELECT id, run, actor, after FROM ky_dream_ledger").toArray());
    const newest = await inside(name, (instance) => instance.skills.history("weekly-groceries")[0]!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run: session, actor: "review", after: newest });
    expect(await ledger(name)).toEqual([]);

    expect(await inside(name, (instance) => instance.ledger.undo(Number(rows[0]!.id)))).toContain("Saved revert of weekly-groceries");
    expect(await body(name, "weekly-groceries")).toContain("oat milk");
  });
});

describe("provenance", () => {
  it("is backfilled from each skill's first version when created_by is added to an existing table", async () => {
    const name = crypto.randomUUID();

    const origins = await inside(name, (_instance, state) => {
      const sql = state.storage.sql;
      // ky_skills as it was before pins and provenance, with skills the agent, a review, ky's seeds and nobody known made.
      sql.exec("DROP TABLE ky_skills");
      sql.exec(`CREATE TABLE ky_skills (name TEXT PRIMARY KEY, description TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', uses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);

      for (const [skill, actor] of [["by-agent", "agent"], ["by-review", "review"], ["seeded", "ky"], ["unknown", null]] as const) {
        sql.exec("INSERT INTO ky_skills (name, description, body, created_at, updated_at) VALUES (?, 'd', 'b', 1, 1)", skill);

        if (actor !== null) {
          sql.exec("INSERT INTO ky_skill_versions (name, action, actor, description, body, status, created_at) VALUES (?, 'create', ?, 'd', 'b', 'active', 1)", skill, actor);
          // A later change by someone else does not make it theirs.
          sql.exec("INSERT INTO ky_skill_versions (name, action, actor, description, body, status, created_at) VALUES (?, 'edit', 'user', 'd', 'b', 'active', 2)", skill);
        }
      }

      const skills = new Skills(sql);

      return Object.fromEntries(skills.all().map((each) => [each.name, [each.created_by, each.pinned]]));
    });

    expect(origins).toEqual({ "by-agent": ["agent", false], "by-review": ["review", false], seeded: ["user", false], unknown: ["user", false] });
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
    expect(await inside(name, (instance) => instance.skills.stale("stale-test", Date.now() + 10 * DAY))).toEqual([]);

    const archived = await inside(name, (instance) => {
      instance.skills.view("opened");

      return instance.skills.stale("stale-test", Date.now() + 61 * DAY);
    });

    // "opened" was used just now, so 61 days on it is 61 days unused too; one opened later stays.
    expect(archived.sort()).toEqual(["opened", "unused"]);
    expect(await inside(name, (instance) => instance.skills.stale("stale-test", Date.now() + 61 * DAY))).toEqual([]);
    expect(await inside(name, (instance) => instance.skills.list().map((each) => each.name))).toEqual(["pinned", "users"]);
    const rows = await ledger(name);
    expect(rows).toMatchObject([
      { kind: "skill", action: "archive", reason: "Not used in 60 days" },
      { kind: "skill", action: "archive", reason: "Not used in 60 days" }
    ]);
    expect(rows.map((row) => row.run)).toEqual(["stale-test", "stale-test"]);
  });

  it("shares the dream's run, so the dream may not change again what it archived that night", async () => {
    const name = crypto.randomUUID();
    await prompt(name, "hello");
    await inside(name, (instance, state) => {
      instance.skills.reviewAfter = 99;
      instance.skills.apply({ action: "create", name: "old-errand", description: "old-errand", body: "Steps." }, "agent");
      state.storage.sql.exec("UPDATE ky_skills SET created_at = ? WHERE name = 'old-errand'", Date.now() - 70 * DAY);
      instance.memory.note("the user likes green tea");
    });
    await inside(name, (instance) => instance.dreaming.run());

    const dream = await inside(name, (instance) => instance.feed.list().find((task) => task.worker === "dreaming"));
    expect(await inside(name, (instance) => instance.skills.get("old-errand")?.status)).toBe("archived");
    const said = (text: string) => inside(name, async (instance) => (await instance.harness.session(dream!.session!).prompt(text)).text);

    expect(await said(tool("skill_manage", { action: "edit", name: "old-errand", body: "New steps." }))).toContain("This run already changed old-errand (archive)");
    expect(await ledger(name)).toMatchObject([{ action: "archive", target: "old-errand", run: dream!.id, actor: "dream" }]);
  });

  it("keeps a skill opened lately, and one whose archive the user undid", async () => {
    const name = crypto.randomUUID();

    const archived = await inside(name, (instance) => {
      instance.skills.apply({ action: "create", name: "kept", description: "kept", body: "Steps." }, "agent");

      return instance.skills.stale("stale-test", Date.now() + 61 * DAY);
    });

    expect(archived).toEqual(["kept"]);

    const [row] = await ledger(name);
    await inside(name, (instance) => instance.ledger.undo(row!.id));
    expect(await inside(name, (instance) => instance.skills.get("kept")?.status)).toBe("active");
    // The undo is the user's change, so the next pass counts from it.
    expect(await inside(name, (instance) => instance.skills.stale("stale-test", Date.now() + 30 * DAY))).toEqual([]);
  });
});

describe("a damaged ledger row", () => {
  it("is skipped by last night's list and by the guard, and the rest still read", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);
    await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" }));
    await inside(name, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO ky_dream_ledger (run, kind, action, target, before, at) VALUES ('x', 'bogus', 'patch', 'grocery-run', NULL, ?)", Date.now());
    });

    expect(await ledger(name)).toMatchObject([{ action: "patch", target: "weekly-groceries" }]);
    expect(await said(tool("skill_manage", { action: "patch", name: "grocery-run", old: "oat milk", new: "soy milk" }))).toContain("Saved patch");
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

  it("is refused once the user changed or pinned the skill since, saying what changed", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);
    await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" }));
    await said(skill("tea-order"));
    const [patch, create] = await ledger(name);

    await inside(name, (instance) => {
      instance.skills.apply({ action: "patch", name: "weekly-groceries", old: "Open the list", new: "Open the shared list" }, "user");
      instance.skills.apply({ action: "pin", name: "tea-order" }, "user");
    });

    await expect(inside(name, (instance) => instance.ledger.undo(patch!.id))).rejects.toThrow(/weekly-groceries changed after this patch \(version \d+, patch by user\)/);
    await expect(inside(name, (instance) => instance.ledger.undo(create!.id))).rejects.toThrow("tea-order was pinned since");
    expect(await body(name, "weekly-groceries")).toContain("Open the shared list");
    expect(await body(name, "weekly-groceries")).toContain("soy milk");
    expect(await inside(name, (instance) => instance.skills.get("tea-order")?.status)).toBe("active");
    expect((await ledger(name)).map((row) => row.undone_at)).toEqual([null, null]);
  });

  it("of a row from before `after` was kept puts the skill back as it did", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);
    await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" }));
    const [patch] = await ledger(name);
    await inside(name, (instance, state) => {
      state.storage.sql.exec("UPDATE ky_dream_ledger SET after = NULL, actor = NULL");
      instance.skills.apply({ action: "patch", name: "weekly-groceries", old: "Open the list", new: "Open the shared list" }, "user");
    });

    expect(await inside(name, (instance) => instance.ledger.undo(patch!.id))).toContain("Saved revert of weekly-groceries");
    expect(await body(name, "weekly-groceries")).toContain("oat milk");
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
    expect(await said(tool("memory_forget", { block: "0-1" }))).toContain("This run already changed 0-1");
    const [forget] = await ledger(name);
    expect(forget).toMatchObject({ kind: "memory", action: "forget", target: "0-1", before: "the user drinks green tea, then oolong" });

    expect(await inside(name, (instance) => instance.ledger.undo(forget!.id))).toBe(`Saved as #${before}.`);
    expect(await inside(name, (instance) => instance.memory.recall("then oolong"))).toContain("the user drinks green tea, then oolong");
    expect(await inside(name, (instance) => instance.memory.count())).toBe(before + 1);
  });

  it("notes a summary over a memory's 280 bytes again, cut to them", async () => {
    const name = crypto.randomUUID();
    const said = await dreamt(name);
    const long = `the user drinks green tea, then oolong; ${"and much more about tea ".repeat(20)}`.trim();
    await inside(name, (instance, state) => {
      instance.memory.note("the user switched to oolong");
      state.storage.sql.exec("INSERT OR REPLACE INTO memo_tree (lo, hi, text) VALUES (0, 2, ?)", long);
    });
    const before = await inside(name, (instance) => instance.memory.count());

    expect(await said(tool("memory_forget", { block: "0-1" }))).toContain("Forgot");
    const [forget] = await ledger(name);
    expect(await inside(name, (instance) => instance.ledger.undo(forget!.id))).toBe(`Saved as #${before}. It was ${long.length} bytes, so it was cut to 280.`);
    const restored = await inside(name, (_instance, state) => state.storage.sql.exec<{ text: string }>("SELECT text FROM memo_log WHERE id = ?", before).one().text);
    expect(restored).toBe(long.slice(0, 280).trim());
    expect((await ledger(name))[0]?.undone_at).not.toBeNull();
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
