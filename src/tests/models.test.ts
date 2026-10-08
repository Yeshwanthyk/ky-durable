import { describe, expect, it } from "vitest";
import type { Slot, SlotSetting } from "../settings";
import { agent, inside, prompt } from "./drive";
import type { FauxCall } from "./stack";

/**
 * Which model each slot runs on, on ky's real composition: Claude through the
 * fake VibeProxy on the Mac, and the faux cloud provider where OpenCode Go
 * stands. Each test gets a fresh object with the Mac online or away.
 */
async function fresh(macUp: boolean): Promise<string> {
  const name = crypto.randomUUID();
  await agent(name).mac(macUp);

  return name;
}

function resolve(name: string, slot: Slot) {
  return inside(name, async (instance) => {
    const { provider, model, thinkingLevel, fellBack } = await instance.models.resolve(slot);

    return { provider: provider.id, modelId: model.id, thinkingLevel, fellBack };
  });
}

/** Store a slot choice; the stored setting, or why it was refused. */
function set(name: string, slot: Slot, setting: SlotSetting): Promise<SlotSetting | string> {
  return inside(name, (instance) => {
    try {
      return instance.models.settings.set(slot, setting);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

function calls(name: string): Promise<FauxCall[]> {
  return inside(name, (instance) => [...instance.boundary.calls]);
}

function title(name: string, text: string): Promise<string | null> {
  return inside(name, (instance) => instance.titler.title(text));
}

function imageSupport(name: string, slot: Slot): Promise<string | null> {
  return inside(name, (instance) => instance.models.imageSupport(slot));
}

describe("which model each slot uses", () => {
  it("puts the main agent and titles on Claude while the Mac is online", async () => {
    const name = await fresh(true);

    expect(await resolve(name, "main")).toEqual({
      provider: "vibeproxy",
      modelId: "claude-opus-5-5",
      thinkingLevel: "medium",
      fellBack: false
    });
    expect(await resolve(name, "titles")).toMatchObject({
      provider: "vibeproxy",
      modelId: "claude-haiku-4-5",
      thinkingLevel: "off"
    });
    expect(await resolve(name, "subagents")).toEqual({
      provider: "faux",
      modelId: "faux",
      thinkingLevel: "high",
      fellBack: false
    });
    expect(await resolve(name, "fallback")).toMatchObject({ provider: "faux", modelId: "faux", thinkingLevel: "high" });
  });

  it("puts every slot on the cloud model while the Mac is away, and shows Claude as not connected", async () => {
    const name = await fresh(false);

    expect(await resolve(name, "main")).toEqual({
      provider: "faux",
      modelId: "faux",
      thinkingLevel: "high",
      fellBack: false
    });
    expect(await resolve(name, "titles")).toMatchObject({ provider: "faux", modelId: "faux", thinkingLevel: "off" });

    const connected = await inside(name, (instance) =>
      instance.models.catalog().map(({ id, connected }) => ({ id, connected }))
    );

    expect(connected).toEqual([
      { id: "vibeproxy", connected: false },
      { id: "faux", connected: true }
    ]);
  });

  it("stores a slot choice, and refuses a provider that is not connected", async () => {
    const name = await fresh(false);

    expect(await set(name, "subagents", { provider: "faux", modelId: "faux-text", thinkingLevel: "high" })).toEqual({
      provider: "faux",
      modelId: "faux-text",
      thinkingLevel: "off"
    });
    expect(await resolve(name, "subagents")).toMatchObject({ modelId: "faux-text", thinkingLevel: "off" });
    expect(await set(name, "main", { provider: "vibeproxy", modelId: "claude-opus-5-5", thinkingLevel: "medium" })).toBe(
      "vibeproxy/claude-opus-5-5 is not available."
    );
  });

  it("gives a slot on Claude the fallback slot's model when the Mac has just gone away", async () => {
    const name = await fresh(true);
    expect(await resolve(name, "main")).toMatchObject({ provider: "vibeproxy" });
    await agent(name).macLeaves();

    expect(await resolve(name, "main")).toEqual({
      provider: "faux",
      modelId: "faux",
      thinkingLevel: "high",
      fellBack: true
    });
  });
});

describe("a turn on Claude", () => {
  it("runs on Claude while the Mac is online", async () => {
    const name = await fresh(true);

    expect((await prompt(name, "hello")).text).toBe('Title: "Claude claude-opus-5-5 (thinking adaptive)"\nhello');
    expect(await calls(name)).toEqual([]);
  });

  it("runs on the fallback slot's model, with its key, when the Mac has just gone away, and on Claude once it is back", async () => {
    const name = await fresh(true);
    await agent(name).macLeaves();

    // VIBEPROXY refuses the probe, so the whole turn streams from the cloud model alone, with the cloud's key.
    expect((await prompt(name, "hello")).text).toBe("echo: hello");
    expect((await calls(name)).map(({ model, reasoning, apiKey }) => ({ model, reasoning, apiKey }))).toEqual([
      { model: "faux", reasoning: "high", apiKey: "faux-key" }
    ]);

    await agent(name).mac(true);
    expect((await prompt(name, "again")).text).toBe('Title: "Claude claude-opus-5-5 (thinking adaptive)"\nagain');
    expect(await calls(name)).toHaveLength(1);
  });
});

describe("naming chats and tasks with the titles slot", () => {
  it("asks Claude's small model without thinking while the Mac is online, and keeps the bare title", async () => {
    const name = await fresh(true);

    expect(await title(name, "Plan a trip to Lisbon")).toBe("Claude claude-haiku-4-5 (thinking disabled)");
    expect(await calls(name)).toEqual([]);
  });

  it("asks the cloud model, still without thinking, while the Mac is away", async () => {
    const name = await fresh(false);

    expect(await title(name, "Plan a trip to Lisbon")).toBe("Named: Plan a trip to Lisbon");
    expect((await calls(name)).map(({ model, reasoning }) => ({ model, reasoning }))).toEqual([
      { model: "faux", reasoning: null }
    ]);
  });

  it("keeps its light thinking on the stand-in when the Mac has just gone away", async () => {
    const name = await fresh(true);
    await agent(name).macLeaves();

    expect(await title(name, "Plan a trip")).toBe("Named: Plan a trip");
    expect((await calls(name)).map(({ reasoning }) => reasoning)).toEqual([null]);
  });

  it("gives up quietly when the model fails or there is nothing to name", async () => {
    const online = await fresh(true);
    const away = await fresh(false);

    // fake-vibeproxy.ts fails on "fail", the faux model on "no-title".
    expect(await title(online, "fail no-title")).toBeNull();
    expect(await title(away, "fail no-title")).toBeNull();
    expect(await title(online, "   ")).toBeNull();
  });

  it("trims a long title to fit", async () => {
    const name = await fresh(false);
    const named = await title(name, "a".repeat(80));

    expect(named).toHaveLength(60);
    expect(named).toMatch(/^Named: a+…$/);
  });
});

describe("whether a slot's model reads images", () => {
  it("checks the model the slot runs on", async () => {
    const name = await fresh(false);

    expect(await imageSupport(name, "main")).toBeNull();
    await set(name, "subagents", { provider: "faux", modelId: "faux-text", thinkingLevel: "off" });
    expect(await imageSupport(name, "subagents")).toMatch(/^Faux Text can't read images/);
  });

  it("checks the fallback model while the slot's provider is away", async () => {
    const name = await fresh(true);
    expect(await set(name, "fallback", { provider: "faux", modelId: "faux-text", thinkingLevel: "off" })).toMatchObject({
      modelId: "faux-text"
    });
    // Claude reads images.
    expect(await imageSupport(name, "main")).toBeNull();

    await agent(name).macLeaves();
    expect(await imageSupport(name, "main")).toMatch(/^Faux Text can't read images/);
  });
});
