import type { JsonValue } from "@earendil-works/pi-ai";
import { ROOT_SESSION } from "agents/harness/pi";
import { describe, expect, it } from "vitest";
import { TEMPLATE } from "../soul";
import { inside, prompt } from "./drive";

/** SOUL.md through ky's real PiAgent on the fake AI binding: the seed, the prompt section, and soul_edit's versions. */

const tool = (args: Record<string, JsonValue>) => `tool soul_edit ${JSON.stringify(args)}`;

const system = (name: string) => inside(name, (instance) => instance.boundary.calls.at(-1)?.system ?? "");

/** The <soul> section of the last request's system prompt, as the wire carried it. */
async function soulSection(name: string): Promise<string | undefined> {
  return (await system(name)).match(/<soul>[\s\S]*?<\/soul>/)?.[0];
}

describe("SOUL.md", () => {
  it("is seeded from the template on first read, once", async () => {
    const name = crypto.randomUUID();
    // Read twice: the second read finds the seed, and seeds nothing more.
    await inside(name, (instance) => [instance.soul.current(), instance.soul.current()]);
    const versions = await inside(name, (instance) => instance.soul.history());

    expect(versions).toMatchObject([{ id: 1, action: "create", actor: "template", body: TEMPLATE }]);
    expect(TEMPLATE).toContain("*You're not a chatbot. You're becoming someone.*");
  });

  it("sits in its own section before the preamble's rules, read fresh each turn", async () => {
    const name = crypto.randomUUID();
    await prompt(name, "hello");
    const soul = `<soul>\n${TEMPLATE.trim()}\n</soul>`;
    expect(await soulSection(name)).toBe(soul);
    // The soul, then its rules, then the preamble.
    const text = await system(name);
    expect(text.slice(0, soul.length + 2)).toBe(`${soul}\n\n`);
    expect(text.indexOf("The <soul> section is SOUL.md")).toBe(soul.length + 2);
    expect(text.indexOf("You are ky,")).toBeGreaterThan(soul.length);

    // A user edit between turns shows on the next request.
    await inside(name, (instance) => instance.soul.apply({ action: "edit", body: "# SOUL.md\nSpeak like a pirate." }, "user"));
    await prompt(name, "hello again");
    expect(await soulSection(name)).toBe("<soul>\n# SOUL.md\nSpeak like a pirate.\n</soul>");
  });

  it("edits, patches and reverts through soul_edit, keeping every version", async () => {
    const name = crypto.randomUUID();
    expect((await prompt(name, tool({ action: "view" }))).text).toBe(`tool said: ${TEMPLATE}`);

    const edited = await prompt(name, tool({ action: "edit", body: "# SOUL.md\nBe brief. Be warm." }));
    expect(edited.text).toBe("tool said: Saved edit of SOUL.md (version 2).");

    const patched = await prompt(name, tool({ action: "patch", old: "Be warm.", new: "Be dry." }));
    expect(patched.text).toBe("tool said: Saved patch of SOUL.md (version 3).");
    expect((await prompt(name, tool({ action: "view" }))).text).toBe("tool said: # SOUL.md\nBe brief. Be dry.");

    const history = (await prompt(name, tool({ action: "history" }))).text;
    expect(history).toMatch(/v3 .* patch by agent\nv2 .* edit by agent\nv1 .* create by template/);

    await prompt(name, tool({ action: "revert", version: 1 }));
    expect(await inside(name, (instance) => instance.soul.current().body)).toBe(TEMPLATE);
    expect(await inside(name, (instance) => instance.soul.history().map((each) => each.conversation))).toEqual([
      ROOT_SESSION,
      ROOT_SESSION,
      ROOT_SESSION,
      null
    ]);
  });

  it("refuses a patch that does not match once, and an empty file", async () => {
    const name = crypto.randomUUID();
    const missing = await prompt(name, tool({ action: "patch", old: "no such text", new: "x" }));
    expect(missing.text).toContain("The text to replace is not in SOUL.md.");

    const twice = await prompt(name, tool({ action: "patch", old: "**", new: "__" }));
    expect(twice.text).toMatch(/appears \d+ times in SOUL.md/);

    expect((await prompt(name, tool({ action: "edit", body: "  " }))).text).toContain("SOUL.md cannot be empty.");
    expect(await inside(name, (instance) => instance.soul.history().length)).toBe(1);
  });

  it("tells ky when to change it", async () => {
    const name = crypto.randomUUID();
    await prompt(name, "hello");
    expect(await system(name)).toContain("Change it with soul_edit only when the user asks or clearly agrees");
  });
});
