import { describe, expect, it } from "vitest";
import { Models } from "../models";
import type { ModelChoice, Purpose } from "../settings";
import { agent, inside, prompt } from "./drive";
import type { AiCall } from "../../test/fakes/ai";
import { BARE, GLM, GPT_OSS, KEYED, KIMI, OPENCODE_KEY } from "./stack";

/**
 * Which model each purpose runs on, on ky's real composition: Workers AI
 * behind the fake AI binding on every object, Claude through the fake
 * VibeProxy on the Mac where the overlay is, and OpenCode Go behind the fake
 * fetch on a keyed object. Each test gets a fresh object.
 */

const WORKERS_AI_URL = "https://workers-binding.ai/ai-gateway/gateways/default/compat/chat/completions";

const CLAUDE = 'Title: "Claude claude-opus-5-5 (thinking adaptive)"';

/** A fresh object: a deploy with no overlay or secrets, or with the overlay and the Mac online or away, or with OpenCode Go's key. */
async function fresh(deploy: "bare" | "mac-up" | "mac-away" | "keyed"): Promise<string> {
  const name = `${deploy === "bare" ? BARE : deploy === "keyed" ? KEYED : ""}${crypto.randomUUID()}`;
  await agent(name).mac(deploy === "mac-up");

  return name;
}

function resolve(name: string, purpose: Purpose): Promise<ModelChoice> {
  return inside(name, (instance) => instance.models.resolve(purpose).choice);
}

/** Store a purpose's choice; the stored choice, or why it was refused. */
function set(name: string, purpose: Purpose, choice: ModelChoice): Promise<ModelChoice | string> {
  return inside(name, (instance) => {
    try {
      return instance.models.settings.set(purpose, choice);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

function calls(name: string): Promise<AiCall[]> {
  return inside(name, (instance) => [...instance.boundary.calls]);
}

function title(name: string, text: string): Promise<string | null> {
  return inside(name, (instance) => instance.titler.title(text));
}

function imageSupport(name: string, purpose: Purpose): Promise<string | null> {
  return inside(name, (instance) => instance.models.imageSupport(purpose));
}

describe("which model each purpose uses", () => {
  it("runs everything on Workers AI on a deploy with no secrets", async () => {
    const name = await fresh("bare");

    // GLM takes no thinking level; it thinks on its own.
    expect(await resolve(name, "main")).toEqual({ provider: "workers-ai", modelId: GLM, thinkingLevel: "off" });
    expect(await resolve(name, "worker")).toEqual({ provider: "workers-ai", modelId: GLM, thinkingLevel: "off" });
    expect(await resolve(name, "background")).toEqual({ provider: "workers-ai", modelId: GLM, thinkingLevel: "off" });
    // No other provider, so the fallback is Workers AI's next model.
    expect(await resolve(name, "fallback")).toEqual({ provider: "workers-ai", modelId: KIMI, thinkingLevel: "high" });

    const catalog = await inside(name, (instance) =>
      instance.models.catalog().map(({ id, connected, models }) => ({ id, connected, models: models.map((model) => model.modelId) }))
    );

    expect(catalog).toEqual([{ id: "workers-ai", connected: true, models: [GLM, KIMI, GPT_OSS] }]);
  });

  it("puts the main agent and the worker on Claude while the Mac is online, with Workers AI as the fallback", async () => {
    const name = await fresh("mac-up");

    expect(await resolve(name, "main")).toEqual({ provider: "vibeproxy", modelId: "claude-opus-5-5", thinkingLevel: "medium" });
    expect(await resolve(name, "worker")).toEqual({ provider: "vibeproxy", modelId: "claude-opus-5-5", thinkingLevel: "medium" });
    expect(await resolve(name, "background")).toMatchObject({ provider: "workers-ai", modelId: GLM, thinkingLevel: "off" });
    expect(await resolve(name, "fallback")).toEqual({ provider: "workers-ai", modelId: GLM, thinkingLevel: "off" });
  });

  it("puts the main agent on Workers AI while the Mac is away, and shows Claude as not connected", async () => {
    const name = await fresh("mac-away");

    expect(await resolve(name, "main")).toMatchObject({ provider: "workers-ai", modelId: GLM });

    const connected = await inside(name, (instance) =>
      instance.models.catalog().map(({ id, connected }) => ({ id, connected }))
    );

    expect(connected).toEqual([
      { id: "vibeproxy", connected: false },
      { id: "workers-ai", connected: true }
    ]);
  });

  it("puts the main agent on OpenCode Go when its key is set, with Workers AI as the fallback", async () => {
    const name = await fresh("keyed");

    expect(await resolve(name, "main")).toEqual({ provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinkingLevel: "high" });
    expect(await resolve(name, "fallback")).toEqual({ provider: "workers-ai", modelId: GLM, thinkingLevel: "off" });
  });

  it("puts the background on main's model while the Workers AI record is disabled, and runs nothing with no provider", async () => {
    const keyed = await fresh("keyed");
    const bare = await fresh("bare");

    const disabled = (name: string) =>
      inside(name, (instance, state) => {
        state.storage.sql.exec("UPDATE ky_providers SET enabled = 0 WHERE id = 'workers-ai'");
        const models = new Models(state.storage.sql, instance.boundary, () => {});

        try {
          return models.resolve("background").choice;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });

    expect(await disabled(keyed)).toMatchObject({ provider: "opencode-go", modelId: "deepseek-v4.1-flash" });
    expect(await disabled(bare)).toBe("No model provider is enabled.");
  });

  it("stores a purpose's choice at a level its model has, and refuses a provider that is not connected", async () => {
    const name = await fresh("mac-away");

    expect(await set(name, "worker", { provider: "workers-ai", modelId: GPT_OSS, thinkingLevel: "xhigh" })).toEqual({
      provider: "workers-ai",
      modelId: GPT_OSS,
      thinkingLevel: "high"
    });
    expect(await resolve(name, "worker")).toMatchObject({ modelId: GPT_OSS });
    expect(await set(name, "main", { provider: "vibeproxy", modelId: "claude-opus-5-5", thinkingLevel: "medium" })).toBe(
      "vibeproxy/claude-opus-5-5 is not available."
    );
  });
});

describe("a turn", () => {
  it("chats and calls tools on Workers AI through the AI binding, with no key of the user's", async () => {
    const name = await fresh("bare");

    expect((await prompt(name, "multiply 4")).text).toBe("tool said: 12");

    const sent = await calls(name);
    expect(sent.map(({ url, model }) => ({ url, model }))).toEqual([
      { url: WORKERS_AI_URL, model: GLM },
      { url: WORKERS_AI_URL, model: GLM }
    ]);
    // The gateway's placeholder, and no Authorization it would take as a key of the caller's.
    expect(sent[0]!.headers).toMatchObject({ "cf-aig-authorization": "Bearer cloudflare-gateway-binding" });
    expect(sent[0]!.headers.authorization).toBeUndefined();
  });

  it("runs on OpenCode Go with its key when that is set", async () => {
    const name = await fresh("keyed");

    expect((await prompt(name, "hello")).text).toBe("echo: hello");

    const [sent] = await calls(name);
    expect(sent).toMatchObject({ url: "https://opencode.ai/zen/go/v1/chat/completions", model: "deepseek-v4.1-flash" });
    expect(sent!.headers.authorization).toBe(`Bearer ${OPENCODE_KEY}`);
  });

  it("runs on Claude while the Mac is online", async () => {
    const name = await fresh("mac-up");

    expect((await prompt(name, "hello")).text).toBe(`${CLAUDE}\nhello`);
    expect(await calls(name)).toEqual([]);
  });

  it("runs on the fallback's model when the Mac has just gone away, and on Claude once it is back", async () => {
    const name = await fresh("mac-up");
    await agent(name).macLeaves();

    // VIBEPROXY refuses the probe, so the whole turn streams from Workers AI alone.
    expect((await prompt(name, "hello")).text).toBe("echo: hello");
    expect((await calls(name)).map(({ model }) => model)).toEqual([GLM]);

    await agent(name).mac(true);
    expect((await prompt(name, "again")).text).toBe(`${CLAUDE}\nagain`);
    expect(await calls(name)).toHaveLength(1);
  });

  it("stands in once a request to the provider fails to send, though its probe still answers", async () => {
    const name = await fresh("mac-up");
    await agent(name).tunnelDrops();

    // The tunnel drops Claude's request, which opens VibeProxy's breaker; pi retries, and the retry runs on Workers AI.
    expect((await prompt(name, "hello")).text).toBe("echo: hello");
    expect((await calls(name)).map(({ model }) => model)).toEqual([GLM]);
  });

  it("stands in for a provider whose breaker opened, on another provider", async () => {
    const name = await fresh("keyed");
    await set(name, "main", { provider: "workers-ai", modelId: GLM, thinkingLevel: "high" });
    await inside(name, (instance) => instance.applyMain());
    await agent(name).provider("workers-ai", false);

    // Workers AI answers 429, which opens its breaker; from then on calls run on OpenCode Go.
    await prompt(name, "first");
    expect((await prompt(name, "second")).text).toBe("echo: second");

    const sent = await calls(name);
    expect(sent[0]).toMatchObject({ model: GLM });
    expect(sent.at(-1)).toMatchObject({ model: "deepseek-v4.1-flash" });
  });

  it("ends a turn whose providers are all down, without bouncing between their stand-ins", async () => {
    const name = await fresh("keyed");
    await set(name, "main", { provider: "workers-ai", modelId: GLM, thinkingLevel: "off" });
    await inside(name, (instance) => instance.applyMain());
    await agent(name).provider("workers-ai", false);
    await agent(name).provider("opencode-go", false);

    // Workers AI's 429 opens its breaker, then OpenCode Go stands in and its 402 opens its own.
    expect(await prompt(name, "first")).toMatchObject({ status: "unanswered" });
    expect((await calls(name)).map(({ model }) => model)).toEqual([GLM, "deepseek-v4.1-flash"]);

    // With no provider healthy, each call goes to Workers AI itself and fails there, until pi's retries run out.
    expect(await prompt(name, "second")).toMatchObject({ status: "unanswered" });
    const later = (await calls(name)).slice(2).map(({ model }) => model);
    expect(later.length).toBeGreaterThan(0);
    expect(new Set(later)).toEqual(new Set([GLM]));
    // pi retries a 429 five times from 1s (server.ts), about 31s in all.
  }, 60_000);
});

describe("thinking on Workers AI", () => {
  it("offers each model the levels its endpoint honours", async () => {
    const name = await fresh("bare");

    const levels = await inside(name, (instance) =>
      instance.models.catalog()[0]!.models.map(({ modelId, levels }) => ({ modelId, levels }))
    );

    expect(levels).toEqual([
      { modelId: GLM, levels: ["off"] },
      { modelId: KIMI, levels: ["off", "high"] },
      { modelId: GPT_OSS, levels: ["low", "medium", "high"] }
    ]);
  });

  it("sends each model's level as reasoning_effort, and none for GLM", async () => {
    const name = await fresh("bare");

    const sentFor = async (purpose: Purpose, choice: ModelChoice) => {
      await set(name, purpose, choice);
      await inside(name, (instance) => instance.applyMain());
      const before = (await calls(name)).length;
      await (purpose === "main" ? prompt(name, "hello") : title(name, "Plan a trip"));

      return (await calls(name)).slice(before).map(({ reasoning }) => reasoning);
    };

    expect(await sentFor("main", { provider: "workers-ai", modelId: GLM, thinkingLevel: "high" })).toEqual([null]);
    expect(await sentFor("main", { provider: "workers-ai", modelId: KIMI, thinkingLevel: "high" })).toEqual(["high"]);
    expect(await sentFor("background", { provider: "workers-ai", modelId: KIMI, thinkingLevel: "off" })).toEqual(["none"]);
    // GPT OSS can't stop thinking, so off is stored as its lowest level.
    expect(await sentFor("background", { provider: "workers-ai", modelId: GPT_OSS, thinkingLevel: "off" })).toEqual(["low"]);
  });
});

describe("naming chats and tasks on the background purpose", () => {
  it("asks Workers AI even while the Mac is online, and keeps the bare title", async () => {
    const name = await fresh("mac-up");

    expect(await title(name, "Plan a trip to Lisbon")).toBe("Named: Plan a trip to Lisbon");
    expect((await calls(name)).map(({ model, system }) => ({ model, named: system.startsWith("You name things") }))).toEqual([
      { model: GLM, named: true }
    ]);
  });

  it("stands in for Workers AI on the cheapest healthy provider's light model, never on Claude's main one", async () => {
    const mac = await fresh("mac-up");
    const both = await fresh("keyed");
    await agent(both).mac(true);

    for (const name of [mac, both]) {
      await agent(name).provider("workers-ai", false);
      // The 429 opens Workers AI's breaker; this title is lost, and the next stands in.
      expect(await title(name, "first")).toBeNull();
    }

    expect(await title(mac, "Plan a trip")).toBe("Claude claude-haiku-4-5 (thinking disabled)");
    // OpenCode Go is cheaper than the Mac.
    expect(await title(both, "Plan a trip")).toBe("Named: Plan a trip");
    expect((await calls(both)).at(-1)).toMatchObject({ model: "deepseek-v4.1-flash" });
  });

  it("gives up quietly when the model fails or there is nothing to name", async () => {
    const name = await fresh("bare");

    // The fake AI script refuses "no-title" with a 400.
    expect(await title(name, "no-title")).toBeNull();
    expect(await title(name, "   ")).toBeNull();
  });

  it("trims a long title to fit", async () => {
    const name = await fresh("bare");
    const named = await title(name, "a".repeat(80));

    expect(named).toHaveLength(60);
    expect(named).toMatch(/^Named: a+…$/);
  });
});

describe("whether a purpose's model reads images", () => {
  it("checks the model the purpose runs on", async () => {
    const name = await fresh("bare");

    expect(await imageSupport(name, "main")).toBeNull();
    await set(name, "worker", { provider: "workers-ai", modelId: GPT_OSS, thinkingLevel: "off" });
    expect(await imageSupport(name, "worker")).toMatch(/^GPT OSS 120B can't read images/);
  });

  it("checks the fallback's model while the purpose's provider is away", async () => {
    const name = await fresh("mac-up");
    expect(await set(name, "fallback", { provider: "workers-ai", modelId: GPT_OSS, thinkingLevel: "off" })).toMatchObject({
      modelId: GPT_OSS
    });
    // Claude reads images.
    expect(await imageSupport(name, "main")).toBeNull();

    await agent(name).macLeaves();
    expect(await imageSupport(name, "main")).toMatch(/^GPT OSS 120B can't read images/);
  });
});
