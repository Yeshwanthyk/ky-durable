import type { JsonValue } from "@earendil-works/pi-ai";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { REVIEW_ALLOWED } from "../skills/contract";
import { connect, follow, inside, prompt, promptTool, until } from "./drive";

/** Skills through ky's real PiAgent on the fake AI binding: the tools, the index, and the review after a turn. */

const tool = (name: string, args: Record<string, JsonValue>) => `tool ${name} ${JSON.stringify(args)}`;

const create = () =>
  tool("skill_manage", {
    action: "create",
    name: "weekly-groceries",
    description: "Ordering the weekly groceries",
    body: "1. Open the list.\n2. Order oat milk, never dairy."
  });

function reviews(name: string) {
  return inside(name, (instance) => instance.feed.list().filter((task) => task.worker === "skills"));
}

describe("skills", () => {
  it("creates, opens, patches and reverts a skill, keeping every version", async () => {
    const name = crypto.randomUUID();
    expect((await prompt(name, create())).text).toBe("tool said: Created weekly-groceries (version 1).");

    const patched = await prompt(
      name,
      tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" })
    );

    expect(patched.text).toBe("tool said: Saved patch of weekly-groceries (version 2).");
    expect((await prompt(name, tool("skill_view", { name: "weekly-groceries" }))).text).toContain("Order soy milk");

    const history = (await prompt(name, tool("skill_view", { name: "weekly-groceries", history: true }))).text;
    expect(history).toMatch(/v2 .* patch by agent\nv1 .* create by agent/);

    await prompt(name, tool("skill_manage", { action: "revert", name: "weekly-groceries", version: 1 }));
    expect((await prompt(name, tool("skill_view", { name: "weekly-groceries" }))).text).toContain("Order oat milk");
    const opened = await inside(name, (instance) => instance.skills.get("weekly-groceries"));
    expect(opened?.uses).toBe(2);
    expect(opened?.last_used_at).toBeGreaterThan(0);
    // Each version keeps the conversation that made it.
    expect(await inside(name, (instance) => instance.skills.history("weekly-groceries").map((each) => each.conversation))).toEqual(
      [ROOT_SESSION, ROOT_SESSION, ROOT_SESSION]
    );
  });

  it("saves the user's answers from a chat without a version, and refuses one no need asks or a background run", async () => {
    const name = crypto.randomUUID();
    const body = "1. Order the list.\n\n## Needs\n- store: Which store? (Costco | Safeway)\n- day: Which day?";
    await prompt(name, tool("skill_manage", { action: "create", name: "weekly-groceries", description: "Ordering the weekly groceries", body }));

    const open = (await prompt(name, tool("skill_view", { name: "weekly-groceries" }))).text;
    expect(open).toMatch(/## Open needs\nAsk the user these[\s\S]*- store: Which store\? \(Costco \| Safeway\)\n- day: Which day\?/);

    const saved = await prompt(name, tool("skill_manage", { action: "answer", name: "weekly-groceries", answers: { store: "Costco" } }));
    expect(saved.text).toBe("tool said: Saved an answer for weekly-groceries.");
    const seen = (await prompt(name, tool("skill_view", { name: "weekly-groceries" }))).text;
    expect(seen).toContain("## Answers\n- store: Costco");
    const stillOpen = seen?.split("## Open needs")[1] ?? "";
    expect(stillOpen).toMatch(/- day: Which day\?$/);
    expect(stillOpen).not.toContain("store");

    const typo = await promptTool(name, tool("skill_manage", { action: "answer", name: "weekly-groceries", answers: { shop: "Costco" } }));
    expect(typo.failed).toBe(true);
    expect(typo.text).toContain("weekly-groceries doesn't ask shop; it asks store, day.");

    await inside(name, (instance) => {
      expect(() => instance.skills.apply({ action: "answer", name: "weekly-groceries", answers: { day: "Sunday" } }, "dream")).toThrow(
        "Only the user answers a skill's needs."
      );
      // The panel's answer clears one with a blank, and a revert of the text keeps the answers.
      instance.skills.apply({ action: "answer", name: "weekly-groceries", answers: { day: "Sunday", store: "" } }, "user");
      expect(instance.skills.get("weekly-groceries")?.answers).toEqual({ day: "Sunday" });
      expect(instance.skills.history("weekly-groceries").map((each) => each.action)).toEqual(["create"]);
      instance.skills.apply({ action: "patch", name: "weekly-groceries", old: "Order", new: "Buy" }, "user");
      instance.skills.apply({ action: "revert", name: "weekly-groceries", version: instance.skills.history("weekly-groceries")[1]?.id ?? 0 }, "user");
      expect(instance.skills.get("weekly-groceries")?.answers).toEqual({ day: "Sunday" });
    });
  });

  it("makes a kit that lists its members, marks them in the index, and keeps its kind", async () => {
    const name = crypto.randomUUID();
    await prompt(name, create());
    const body = "Ship a change.\n\n## Members\n- weekly-groceries\n- gone";
    const made = await prompt(name, tool("skill_manage", { action: "create", name: "ship-change", description: "Shipping a change", body, kind: "kit" }));
    expect(made.text).toBe("tool said: Created ship-change (version 2).");

    const opened = (await prompt(name, tool("skill_view", { name: "ship-change" }))).text;
    expect(opened).toMatch(/^tool said: # ship-change \(kit\)/);
    expect(opened).toContain("- weekly-groceries: Ordering the weekly groceries\n- gone (missing)");

    const flip = await promptTool(name, tool("skill_manage", { action: "edit", name: "weekly-groceries", body: "x", kind: "kit" }));
    expect(flip.failed).toBe(true);
    expect(flip.text).toContain("A skill's kind is set when it's created and stays.");

    await inside(name, (instance) => {
      expect(instance.skills.index()).toBe(
        "- ship-change (kit): Shipping a change\n- weekly-groceries (in ship-change): Ordering the weekly groceries"
      );
      // An edit that drops Members, then a revert, leave a kit a kit.
      instance.skills.apply({ action: "edit", name: "ship-change", body: "Ship a change." }, "user");
      instance.skills.apply({ action: "revert", name: "ship-change", version: 2 }, "user");
      expect(instance.skills.get("ship-change")?.kind).toBe("kit");
      expect(instance.skills.get("weekly-groceries")?.kind).toBe("skill");
    });
  });

  it("refuses a bad name, a duplicate, and a patch that does not match once", async () => {
    const name = crypto.randomUUID();
    const bad = await promptTool(name, tool("skill_manage", { action: "create", name: "Fix PR 12", description: "x", body: "y" }));
    expect(bad).toEqual({ text: expect.stringMatching(/^tool said: [\s\S]*Bad skill name "Fix PR 12"/), failed: true });

    await prompt(name, create());
    expect((await prompt(name, create())).text).toContain("weekly-groceries exists; edit or patch it.");

    const missing = await prompt(
      name,
      tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "cheese", new: "bread" })
    );

    expect(missing.text).toContain("The text to replace is not in weekly-groceries.");
  });

  it("refuses a change whose action it doesn't know, instead of restoring the skill", async () => {
    const name = crypto.randomUUID();
    await prompt(name, create());
    await prompt(name, tool("skill_manage", { action: "archive", name: "weekly-groceries" }));

    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.frames.some((frame) => frame.type === "events"));
    const id = crypto.randomUUID();
    socket.send(JSON.stringify({ type: "skill-change", id, change: { action: "delete", name: "weekly-groceries" } }));
    await client.until(() => client.frames.some((frame) => (frame.type === "error" || frame.type === "result") && frame.id === id));

    const refusal = client.frames.find((frame) => frame.type === "error" && frame.id === id);
    // The socket's schema refuses it before the skills domain sees it.
    expect(refusal?.type === "error" ? refusal.message : "").toContain('ky doesn\'t take a "skill-change" message like that one');
    expect(await inside(name, (instance) => instance.skills.history("weekly-groceries").map((each) => each.action))).toEqual(["archive", "create"]);
    expect(await inside(name, (instance) => instance.skills.get("weekly-groceries")?.status)).toBe("archived");
    socket.close();
  });

  it("lets a review, a dream and an episode reflection call only tools ky registers", async () => {
    const name = crypto.randomUUID();
    await prompt(name, "hello");
    // Each is offered every tool the main chat is.
    const registered = await inside(name, (instance) => Object.keys(instance.boundary.calls.at(-1)?.tools ?? {}));

    for (const kind of ["review", "dream", "episode"] as const) expect(registered).toEqual(expect.arrayContaining([...REVIEW_ALLOWED[kind]]));
  });

  it("lists active skills in the system prompt, and drops archived ones", async () => {
    const name = crypto.randomUUID();
    await prompt(name, create());
    await prompt(name, "hello");
    const system = () => inside(name, (instance) => instance.boundary.calls.at(-1)?.system ?? "");
    expect(await system()).toContain("- weekly-groceries: Ordering the weekly groceries");

    await prompt(name, tool("skill_manage", { action: "archive", name: "weekly-groceries" }));
    await prompt(name, "hello again");
    expect(await system()).toContain("No skills yet.");
  });

  it("reviews a busy turn in a fork that remembers and may only touch skills", async () => {
    const name = crypto.randomUUID();
    // Noted before the chat's first turn, so its memory section shows it: wake renders once per context.
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 2;
      instance.memory.note("the user likes green tea");
    });

    // One tool call is under the threshold.
    await prompt(name, "multiply 2");
    await prompt(name, "hello");
    expect(await reviews(name)).toEqual([]);

    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });

    const before = await inside(name, (instance) => instance.boundary.calls.length);
    await prompt(name, "multiply 3");
    await until(async () => (await reviews(name)).some((task) => task.status === "done"), "the review to finish");

    // The fork keeps the memory its chat was shown, so the review sees the user's preferences.
    const asked = await inside(name, (instance) => instance.boundary.calls.slice(before).map((call) => call.system));
    expect(asked.length).toBeGreaterThan(0);

    for (const system of asked) {
      expect(system).toContain("the user likes green tea");
      expect(system).not.toContain('"memory":null');
    }

    const [review] = await reviews(name);
    expect(review).toMatchObject({ kind: "cloud", title: "Skill review", status: "done" });
    // The fake AI binding echoes the review's instructions.
    expect(review!.summary).toMatch(/^echo: \[skill review\]/);

    // The fork holds the turn it reviews, and its own turns are not reviewed again.
    const fork = review!.session!;

    const blocked = await inside(name, async (instance) => {
      const result = await instance.harness.session(fork).prompt("multiply 4");

      return result.text;
    });

    expect(blocked).toContain(
      "Tool call blocked: A skill review may only call skill_view, skill_manage, memory_recall, memory_zoom."
    );
    expect(await inside(name, async (instance) => (await instance.harness.session(fork).prompt(tool("memory_recall", { regex: "tea" }))).text)).toContain(
      "the user likes green tea"
    );

    const made = await inside(name, async (instance) => (await instance.harness.session(fork).prompt(create())).text);
    expect(made).toBe("tool said: Created weekly-groceries (version 1).");

    // Back over the threshold, so the checks below are not reviewed themselves.
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 99;
    });
    expect((await prompt(name, tool("skill_view", { name: "weekly-groceries", history: true }))).text).toMatch(/create by review/);
    expect(await reviews(name)).toHaveLength(1);
  });
});

describe("dreaming", () => {
  const dreams = (name: string) =>
    inside(name, (instance) => instance.feed.list().filter((task) => task.worker === "dreaming"));

  it("is booked nightly, and does nothing when nothing happened", async () => {
    const name = crypto.randomUUID();
    await prompt(name, "hello");

    const booked = await inside(name, async (instance) =>
      (await instance.automations.scheduler.list()).filter((schedule) => schedule.callback === "dream")
    );

    expect(booked).toMatchObject([{ type: "cron", cron: "0 4 * * *" }]);

    // A dream booked at a cron ky no longer uses is dropped on the next start, so ky never dreams twice a night.
    const rebooked = await inside(name, async (instance) => {
      await instance.automations.scheduler.set("0 3 * * *", "dream", undefined, { idempotent: true });
      await instance.automations.recover();

      return (await instance.automations.scheduler.list()).filter((schedule) => schedule.callback === "dream");
    });

    expect(rebooked).toMatchObject([{ type: "cron", cron: "0 4 * * *" }]);

    // What was said is something that happened: the first dream reads "hello", the next finds nothing new.
    await inside(name, (instance) => instance.dreaming.run());
    expect(await dreams(name)).toHaveLength(1);
    await inside(name, (instance) => instance.dreaming.run());
    expect(await dreams(name)).toHaveLength(1);
  });

  it("reads what happened since the last dream in a fresh conversation that wakes with memory", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 99;
    });
    await prompt(name, tool("memory_note", { text: "the user likes green tea" }));
    await prompt(name, create());

    const before = await inside(name, (instance) => instance.boundary.calls.length);
    await inside(name, (instance) => instance.dreaming.run());

    const [dream] = await dreams(name);
    expect(dream).toMatchObject({ kind: "cloud", title: "Dreaming", status: "done" });
    // The scripted dream (src/tests/stack.ts) finds nothing asked of it in the digest and answers so.
    expect(dream!.summary).toBe("Dreamt.");

    const asked = await inside(name, (instance) => instance.boundary.calls.slice(before).map((call) => call.system));
    expect(asked.some((system) => system.includes("the user likes green tea"))).toBe(true);

    const digest = await inside(name, (instance) => instance.dreaming.digest({ memories: 0, at: 0 }));
    expect(digest).toContain("#0 ");
    expect(digest).toContain("the user likes green tea");
    expect(digest).toContain("weekly-groceries: create by agent in the main chat");
    expect(digest).toMatch(/- weekly-groceries: 0 uses, last used never, created \d{4}-\d{2}-\d{2}/);

    // The mark moved on: with nothing new, the next dream does not run.
    expect(await inside(name, (instance) => instance.dreaming.mark().memories)).toBe(1);
    await inside(name, (instance) => instance.dreaming.run());
    expect(await dreams(name)).toHaveLength(1);

    // It may tend skills and memory, and nothing else; its writes are by "dream".
    const session = dream!.session!;
    const said = (text: string) => inside(name, async (instance) => (await instance.harness.session(session).prompt(text)).text);
    expect(await said("multiply 4")).toContain("Tool call blocked: A dream may only call skill_view, skill_manage, memory_recall");
    expect(await said(tool("memory_note", { text: "the user now prefers oolong" }))).toContain("Saved as #1.");
    await said(tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "oat milk", new: "soy milk" }));
    expect(await inside(name, (instance) => instance.skills.history("weekly-groceries")[0]?.actor)).toBe("dream");

    // Its own skill changes are left out of the next digest; its notes are memories like any other.
    const next = await inside(name, (instance) => instance.dreaming.digest(instance.dreaming.mark()));
    expect(next).toContain("the user now prefers oolong");
    expect(next).not.toContain("by dream");
  });
});
