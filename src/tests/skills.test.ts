import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { inside, prompt, until } from "./drive";

/** Skills through ky's real PiAgent on the faux model: the tools, the index, and the review after a turn. */

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
    expect(await inside(name, (instance) => instance.skills.get("weekly-groceries")?.uses)).toBe(2);
  });

  it("refuses a bad name, a duplicate, and a patch that does not match once", async () => {
    const name = crypto.randomUUID();
    const bad = await prompt(name, tool("skill_manage", { action: "create", name: "Fix PR 12", description: "x", body: "y" }));
    expect(bad.text).toMatch(/^tool failed: [\s\S]*Bad skill name "Fix PR 12"/);

    await prompt(name, create());
    expect((await prompt(name, create())).text).toContain("weekly-groceries exists; edit or patch it.");

    const missing = await prompt(
      name,
      tool("skill_manage", { action: "patch", name: "weekly-groceries", old: "cheese", new: "bread" })
    );

    expect(missing.text).toContain("The text to replace is not in weekly-groceries.");
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

  it("reviews a busy turn in a fork that may only touch skills", async () => {
    const name = crypto.randomUUID();
    await inside(name, (instance) => {
      instance.skills.reviewAfter = 2;
    });

    // One tool call is under the threshold.
    await prompt(name, "multiply 2");
    await prompt(name, "hello");
    expect(await reviews(name)).toEqual([]);

    await inside(name, (instance) => {
      instance.skills.reviewAfter = 1;
    });

    await prompt(name, "multiply 3");
    await until(async () => (await reviews(name)).some((task) => task.status === "done"), "the review to finish");
    const [review] = await reviews(name);
    expect(review).toMatchObject({ kind: "cloud", title: "Skill review", status: "done" });
    // The faux model echoes the review's instructions.
    expect(review!.summary).toMatch(/^echo: \[skill review\]/);

    // The fork holds the turn it reviews, and its own turns are not reviewed again.
    const fork = review!.session!;

    const blocked = await inside(name, async (instance) => {
      const result = await instance.harness.session(fork).prompt("multiply 4");

      return result.text;
    });

    expect(blocked).toContain("Tool call blocked: A skill review may only call skill_view and skill_manage.");

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
