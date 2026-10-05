import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** A fresh object with the Mac online or away. */
async function agent(macUp: boolean) {
  const stub = env.MODELS_TEST.getByName(crypto.randomUUID());
  await stub.mac(macUp);

  return stub;
}

describe("which model each slot uses", () => {
  it("puts the main agent and titles on Claude while the Mac is online", async () => {
    const stub = await agent(true);

    expect(await stub.resolve("main")).toEqual({
      provider: "vibeproxy",
      modelId: "claude-opus-5-5",
      thinkingLevel: "medium",
      fellBack: false
    });
    expect(await stub.resolve("titles")).toMatchObject({ provider: "vibeproxy", modelId: "claude-haiku-4-5", thinkingLevel: "off" });
    expect(await stub.resolve("subagents")).toEqual({
      provider: "cloud",
      modelId: "cloud-think",
      thinkingLevel: "high",
      fellBack: false
    });
    expect(await stub.resolve("fallback")).toMatchObject({ provider: "cloud", modelId: "cloud-think", thinkingLevel: "high" });
  });

  it("puts every slot on the cloud model while the Mac is away, and shows Claude as not connected", async () => {
    const stub = await agent(false);

    expect(await stub.resolve("main")).toEqual({
      provider: "cloud",
      modelId: "cloud-think",
      thinkingLevel: "high",
      fellBack: false
    });
    expect(await stub.resolve("titles")).toMatchObject({ provider: "cloud", modelId: "cloud-think", thinkingLevel: "off" });

    const connected = (await stub.catalog()).map(({ id, connected }) => ({ id, connected }));
    expect(connected).toEqual([
      { id: "vibeproxy", connected: false },
      { id: "cloud", connected: true }
    ]);
  });

  it("stores a slot choice, and refuses a provider that is not connected", async () => {
    const stub = await agent(false);

    expect(await stub.set("subagents", { provider: "cloud", modelId: "cloud-text", thinkingLevel: "high" })).toEqual({
      provider: "cloud",
      modelId: "cloud-text",
      thinkingLevel: "off"
    });
    expect(await stub.resolve("subagents")).toMatchObject({ modelId: "cloud-text", thinkingLevel: "off" });
    expect(await stub.set("main", { provider: "vibeproxy", modelId: "claude-opus-5-5", thinkingLevel: "medium" })).toBe(
      "vibeproxy/claude-opus-5-5 is not available."
    );
  });

  it("gives a slot on Claude the fallback slot's model when the Mac has just gone away", async () => {
    const stub = await agent(true);
    expect(await stub.resolve("main")).toMatchObject({ provider: "vibeproxy" });
    await stub.macLeaves();

    expect(await stub.resolve("main")).toEqual({
      provider: "cloud",
      modelId: "cloud-think",
      thinkingLevel: "high",
      fellBack: true
    });
  });
});

describe("a turn on Claude when the Mac is away", () => {
  it("runs on the fallback slot's model, and on Claude once it is back", async () => {
    const stub = await agent(false);

    // VIBEPROXY refuses the probe, so the whole turn streams from the cloud model alone.
    expect(await stub.prompt("hello")).toBe("cloud cloud-think: hello");
    expect((await stub.calls()).map(({ model, reasoning }) => ({ model, reasoning }))).toEqual([
      { model: "cloud-think", reasoning: "high" }
    ]);

    await stub.mac(true);
    expect(await stub.prompt("again")).toMatch(/^Title: "Claude claude-opus-5-5 \(thinking \w+\)"\nagain$/);
    expect(await stub.calls()).toHaveLength(1);
  });

  it("sends the main prompt with ky's repo and working copy from config", async () => {
    const stub = await agent(false);
    await stub.prompt("hello");
    const [{ system }] = await stub.calls();

    expect(system).toContain(
      "your own code is the GitHub repo test-owner/test-repo, with a working copy for you at ~/test-work/ky on the user's Mac."
    );
    expect(system).toContain("1. cd ~/test-work/ky (gh repo clone test-owner/test-repo there if missing).");
    expect(system).toContain("4. Check that https://ky.test/login answers 200.");
    expect(system).not.toMatch(/Yeshwanthyk|ky-durable|workers\.dev/);
  });
});

describe("naming chats and tasks with the titles slot", () => {
  it("asks Claude's small model without thinking while the Mac is online, and keeps the bare title", async () => {
    const stub = await agent(true);

    expect(await stub.title("Plan a trip to Lisbon")).toBe("Claude claude-haiku-4-5 (thinking disabled)");
    expect(await stub.calls()).toEqual([]);
  });

  it("asks the cloud model, still without thinking, while the Mac is away", async () => {
    const stub = await agent(false);

    expect(await stub.title("Plan a trip to Lisbon")).toBe("cloud cloud-think: Plan a trip to Lisbon");
    expect((await stub.calls()).map(({ model, reasoning }) => ({ model, reasoning }))).toEqual([
      { model: "cloud-think", reasoning: null }
    ]);
  });

  it("keeps its light thinking on the stand-in when the Mac has just gone away", async () => {
    const stub = await agent(true);
    await stub.macLeaves();

    expect(await stub.title("Plan a trip")).toBe("cloud cloud-think: Plan a trip");
    expect((await stub.calls()).map(({ reasoning }) => reasoning)).toEqual([null]);
  });

  it("gives up quietly when the model fails or there is nothing to name", async () => {
    const online = await agent(true);
    const away = await agent(false);

    expect(await online.title("fail please")).toBeNull();
    expect(await away.title("fail please")).toBeNull();
    expect(await online.title("   ")).toBeNull();
  });

  it("trims a long title to fit", async () => {
    const stub = await agent(false);
    const title = await stub.title("a".repeat(80));

    expect(title).toHaveLength(60);
    expect(title).toMatch(/^cloud cloud-think: a+…$/);
  });
});

describe("whether a slot's model reads images", () => {
  it("checks the model the slot runs on", async () => {
    const stub = await agent(false);

    expect(await stub.imageSupport("main")).toBeNull();
    await stub.set("subagents", { provider: "cloud", modelId: "cloud-text", thinkingLevel: "off" });
    expect(await stub.imageSupport("subagents")).toMatch(/^Cloud Text can't read images/);
  });

  it("checks the fallback model while the slot's provider is away", async () => {
    const stub = await agent(true);
    expect(await stub.set("fallback", { provider: "cloud", modelId: "cloud-text", thinkingLevel: "off" })).toMatchObject({
      modelId: "cloud-text"
    });
    // Claude reads images.
    expect(await stub.imageSupport("main")).toBeNull();

    await stub.macLeaves();
    expect(await stub.imageSupport("main")).toMatch(/^Cloud Text can't read images/);
  });
});
