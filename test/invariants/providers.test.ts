import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CLAUDE_TOKEN_HERE, CONTEXT_WINDOW } from "../../src/providers/contract";
import type { Purpose } from "../../src/settings/contract";
import { ANTHROPIC_KEY, OPENAI_KEY } from "../fakes/vendors";
import { budget, type Json } from "../parity/kit";
import {
  aChoice,
  COOLDOWN_MS,
  DEVICE,
  DEVICE_ANSWERS,
  LOGIN,
  OPENCODE_KEY,
  POLL_ANSWERS,
  PROBE_TTL_MS,
  REFRESH_ANSWERS,
  REPLIES,
  START,
  World
} from "../parity/providers/world";

const words = {
  noVendor: (id: string) => `ky has no vendor "${id}".`,
  noKey: (vendor: string) => `Paste your ${vendor} API key.`,
  refused: (vendor: string) => `${vendor} refused the key: `,
  unfinished: (vendor: string, reason: string) => `${vendor} didn't finish the test call (${reason}). Try again.`,
  noKeyToRemove: (id: string) => `${id} has no API key to remove.`,
  noProvider: "No model provider is enabled."
};

const VENDORS = ["anthropic", "openai", "opencode-go"] as const;

type VendorId = (typeof VENDORS)[number];

const VENDOR_NAMES = { anthropic: "Anthropic", openai: "OpenAI", "opencode-go": "OpenCode Go" } as const satisfies Record<VendorId, string>;

const VENDOR_KEYS = { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY, "opencode-go": OPENCODE_KEY } as const satisfies Record<VendorId, string>;

const threw = Schema.decodeUnknownOption(Schema.Struct({ threw: Schema.String }));

const refusal = (answer: Json) => Option.getOrUndefined(Option.map(threw(answer), (each) => each.threw));

const runs = () => ({ numRuns: Math.max(10, Math.round(budget().numRuns / 5)), seed: budget().seed });

const aVendor = fc.constantFrom(...VENDORS);

function fresh() {
  const time = { at: START };

  return { world: new World({ now: () => time.at }), time };
}

const providerIds = (world: World) => world.models.catalog().map((provider) => provider.id);

const stored = (world: World) => world.db.prepare("SELECT id, kind, vendor, machine, port, api, label, enabled FROM ky_providers ORDER BY rowid").all();

async function ask(world: World, purpose: Purpose = "main"): Promise<Json> {
  return world.apply({ kind: "ask", purpose, text: "hello", maxTokens: 16 });
}

describe("adding a key", () => {
  it("refuses a vendor ky doesn't have, naming it", () =>
    fc.assert(
      fc.asyncProperty(
        fc.string().filter((id) => !VENDORS.some((vendor) => vendor === id)),
        async (vendor) => {
          const { world } = fresh();

          expect(await world.models.addKey(vendor, ANTHROPIC_KEY)).toEqual({ refused: words.noVendor(vendor) });
          expect(world.vaultLog).toEqual([]);
          expect(world.calls).toEqual([]);
        }
      ),
      runs()
    ));

  it("refuses a blank key, naming the vendor, and calls nobody", () =>
    fc.assert(
      fc.asyncProperty(aVendor, fc.stringMatching(/^[ \t\n]*$/), async (vendor, key) => {
        const { world } = fresh();

        expect(await world.models.addKey(vendor, key)).toEqual({ refused: words.noKey(VENDOR_NAMES[vendor]) });
        expect(world.calls).toEqual([]);
      }),
      runs()
    ));

  it("turns a Claude subscription token away to Subscriptions, and calls nobody", () =>
    fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (before, after) => {
        const { world } = fresh();

        expect(await world.models.addKey("anthropic", `${before}sk-ant-oat${after}`)).toEqual({ refused: CLAUDE_TOKEN_HERE });
        expect(world.calls).toEqual([]);
      }),
      runs()
    ));

  it("keeps a key only when the vendor's test call answers, else refuses with what the vendor said and keeps nothing", () =>
    fc.assert(
      fc.asyncProperty(fc.constantFrom("anthropic" as const, "openai" as const), fc.boolean(), async (vendor, right) => {
        const { world } = fresh();
        const answer = await world.models.addKey(vendor, right ? VENDOR_KEYS[vendor] : "wrong");

        if (right) {
          expect(answer).toEqual({});
          expect(world.keys.get(vendor)).toEqual({ apiKey: VENDOR_KEYS[vendor] });
          expect(providerIds(world)).toContain(vendor);
        } else {
          expect(answer.refused?.startsWith(words.refused(VENDOR_NAMES[vendor]))).toBe(true);
          expect(world.keys.size).toBe(0);
          expect(stored(world).map((row) => row.id)).toEqual(["workers-ai"]);
        }
      }),
      runs()
    ));

  it("refuses a key whose test call doesn't finish, saying how it stopped", async () => {
    const { world } = fresh();

    world.reply = { tool: "multiply", args: { n: 2 } };

    expect(await world.models.addKey("opencode-go", OPENCODE_KEY)).toEqual({ refused: words.unfinished("OpenCode Go", "toolUse") });
    expect(world.keys.size).toBe(0);
  });

  it("stores a kept key's provider as an enabled api-key row under the vendor's id and name, its key only in the vault", () =>
    fc.assert(
      fc.asyncProperty(aVendor, async (vendor) => {
        const { world } = fresh();

        await world.models.addKey(vendor, `  ${VENDOR_KEYS[vendor]}\n`);

        expect(stored(world).at(-1)).toEqual({ id: vendor, kind: "api-key", vendor, machine: null, port: null, api: null, label: VENDOR_NAMES[vendor], enabled: 1 });
        expect(world.vaultLog).toEqual([{ put: "provider", id: vendor, apiKey: VENDOR_KEYS[vendor] }]);
        expect(JSON.stringify(stored(world))).not.toContain(VENDOR_KEYS[vendor]);
      }),
      runs()
    ));

  it("leaves a provider the user turned off off when its key is saved again", () =>
    fc.assert(
      fc.asyncProperty(aVendor, async (vendor) => {
        const { world } = fresh();

        await world.models.addKey(vendor, VENDOR_KEYS[vendor]);
        await world.apply({ kind: "enable", id: vendor, enabled: 0 });
        await world.models.addKey(vendor, VENDOR_KEYS[vendor]);

        expect(stored(world).find((row) => row.id === vendor)?.enabled).toBe(0);
        expect(providerIds(world)).not.toContain(vendor);
      }),
      runs()
    ));
});

describe("removing a key", () => {
  it("removes only an api-key provider's key, refusing any other id by name", () =>
    fc.assert(
      fc.asyncProperty(fc.constantFrom("workers-ai", "vibeproxy", "anthropic", "nope"), async (id) => {
        const { world } = fresh();

        await world.models.addKey("anthropic", ANTHROPIC_KEY);
        const answer = await world.apply({ kind: "removeKey", id });

        if (id === "anthropic") {
          expect(answer).toEqual({});
          expect(world.keys.has("anthropic")).toBe(false);
          expect(stored(world).map((row) => row.id)).not.toContain("anthropic");
        } else {
          expect(answer).toEqual({ threw: words.noKeyToRemove(id) });
          expect(world.keys.has("anthropic")).toBe(true);
        }
      }),
      runs()
    ));
});

describe("choosing a model", () => {
  it("refuses when no provider is enabled", async () => {
    const { world } = fresh();

    await world.apply({ kind: "enable", id: "workers-ai", enabled: 0 });
    await world.apply({ kind: "reboot", tunnel: false });

    expect(await world.apply({ kind: "resolve", purpose: "main", images: false })).toEqual({ threw: words.noProvider });
    expect(await ask(world)).toEqual({ threw: words.noProvider });
  });

  it("lists providers by kind, a machine's first, then keys in the order they were saved, then Workers AI", () =>
    fc.assert(
      fc.asyncProperty(fc.shuffledSubarray([...VENDORS], { minLength: 1 }), fc.boolean(), async (vendors, vibe) => {
        const { world } = fresh();

        if (vibe) {
          await world.apply({ kind: "machine", name: "mac", online: true, shares: true });
          await world.models.refresh();
        }

        for (const vendor of vendors) await world.models.addKey(vendor, VENDOR_KEYS[vendor]);

        expect(providerIds(world)).toEqual([...(vibe ? ["vibeproxy"] : []), ...vendors, "workers-ai"]);
      }),
      runs()
    ));

  it("never offers a model more context than ky compacts at", () =>
    fc.assert(
      fc.asyncProperty(aChoice.filter((choice) => choice.provider !== "gone"), async (choice) => {
        const { world } = fresh();

        for (const vendor of VENDORS) await world.models.addKey(vendor, VENDOR_KEYS[vendor]);
        await world.apply({ kind: "machine", name: "mac", online: true, shares: true });
        await world.models.refresh();
        world.models.settings.set("main", choice);

        const { model } = world.models.resolve("main");
        const windows = world.models.registry.getProvider(model.provider)?.getModels().map((each) => each.contextWindow) ?? [];

        expect(windows.length).toBeGreaterThan(0);
        expect(Math.max(...windows)).toBeLessThanOrEqual(CONTEXT_WINDOW);
      }),
      runs()
    ));

  it("answers a failed call with the provider's own words", () =>
    fc.assert(
      fc.asyncProperty(fc.constantFrom("bad" as const, "unauthorized" as const, "limited" as const, "broken" as const), async (name) => {
        const { world } = fresh();
        const reply = REPLIES[name];

        world.reply = reply;

        expect(refusal(await ask(world))).toContain(reply.error);
        expect(refusal(await world.apply({ kind: "complete", purpose: "main" }))).toContain(reply.error);
      }),
      runs()
    ));
});

describe("time, read from the clock", () => {
  it("runs a provider that failed on a stand-in until a minute has passed on the clock, then goes back to it", () =>
    fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: COOLDOWN_MS - 1 }), fc.integer({ min: 0, max: 600_000 }), async (within, after) => {
        const { world, time } = fresh();

        await world.models.addKey("anthropic", ANTHROPIC_KEY);
        world.models.settings.set("main", { provider: "workers-ai", modelId: "workers-ai/@cf/zai-org/glm-5.3-flash", thinkingLevel: "off" });
        world.down.add("workers-ai");
        await ask(world);
        world.down.delete("workers-ai");

        time.at += within;
        expect(await ask(world)).toMatchObject({ provider: "anthropic" });

        time.at = START + COOLDOWN_MS + after;
        expect(await ask(world)).toMatchObject({ provider: "workers-ai" });
      }),
      runs()
    ));

  it("trusts a VibeProxy probe until probeTtlMs has passed on the clock, then asks again", () =>
    fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: PROBE_TTL_MS - 1 }), fc.integer({ min: 0, max: 600_000 }), async (within, after) => {
        const { world, time } = fresh();
        const connected = () => world.models.catalog().find((provider) => provider.id === "vibeproxy")?.connected;

        await world.apply({ kind: "machine", name: "mac", online: true, shares: true });
        await world.apply({ kind: "refresh" });
        expect(connected()).toBe(true);
        await world.apply({ kind: "probe" });
        world.vibeUp = false;

        time.at += within;
        await world.apply({ kind: "probe" });
        expect(connected()).toBe(true);

        time.at = START + PROBE_TTL_MS + after;
        await world.apply({ kind: "probe" });
        expect(connected()).toBe(false);
      }),
      runs()
    ));
});

describe("stored rows", () => {
  it("skips a row it can't read and serves the rest, through a reboot", () =>
    fc.assert(
      fc.asyncProperty(
        fc.record({ kind: fc.constantFrom("ollama", "", "API-KEY"), enabled: fc.constantFrom<number | string>(1, "yes", "on") }),
        async ({ kind, enabled }) => {
          const { world } = fresh();

          await world.models.addKey("anthropic", ANTHROPIC_KEY);
          world.db.prepare("INSERT INTO ky_providers (id, kind, vendor, machine, port, api, label, enabled) VALUES ('odd', ?, 'openai', NULL, NULL, NULL, 'Odd', 1)").run(kind);
          world.db.prepare("INSERT INTO ky_providers (id, kind, vendor, machine, port, api, label, enabled) VALUES ('openai', 'api-key', 'openai', NULL, NULL, NULL, 'OpenAI', ?)").run(enabled);
          await world.apply({ kind: "reboot", tunnel: false });

          expect(providerIds(world)).toEqual(enabled === 1 ? ["anthropic", "openai", "workers-ai"] : ["anthropic", "workers-ai"]);
          expect(await ask(world)).toMatchObject({ provider: "anthropic" });
        }
      ),
      runs()
    ));
});

describe("ChatGPT sign-in", () => {
  const refusals = {
    garbled: "ChatGPT sign-in failed: an answer ky can't read.",
    interval0: "ChatGPT sign-in failed: an answer ky can't read.",
    refused: "ChatGPT sign-in failed: 401 bad_client.",
    bare500: "ChatGPT sign-in failed: 500.",
    topCode: "ChatGPT sign-in failed: 429 rate_limited.",
    throws: "getaddrinfo ENOTFOUND auth.openai.com"
  } as const satisfies Record<Exclude<(typeof DEVICE_ANSWERS)[number], "ok">, string>;

  it("starts a device sign-in only from an answer it can read, refusing in B's words", () =>
    fc.assert(
      fc.asyncProperty(fc.constantFrom(...DEVICE_ANSWERS), async (answer) => {
        const { world } = fresh();
        const result = await world.apply({ kind: "device", answer });

        expect(result).toEqual(answer === "ok" ? DEVICE : { threw: refusals[answer] });
      }),
      runs()
    ));

  const polled = {
    ok: { ...LOGIN, refreshToken: "refresh-2" },
    pending403: "pending",
    pending404: "pending",
    forbidden: { threw: "ChatGPT sign-in failed: 403 denied." },
    noAccount: { threw: "ChatGPT sign-in failed: the tokens name no account or expiry." },
    badJwt: { threw: "ChatGPT sign-in failed: a token ky can't read." },
    tokenRefused: { threw: "ChatGPT sign-in failed: 400 invalid_grant." },
    throws: { threw: "socket hang up" }
  } as const satisfies Record<(typeof POLL_ANSWERS)[number], Json>;

  it("polls to pending, a login, or a refusal in B's words", () =>
    fc.assert(
      fc.asyncProperty(fc.constantFrom(...POLL_ANSWERS), async (answer) => {
        const { world } = fresh();

        expect(await world.apply({ kind: "poll", answer })).toEqual(polled[answer]);
      }),
      runs()
    ));

  const refreshed = {
    ok: { ...LOGIN, refreshToken: "refresh-2" },
    keeps: { ...LOGIN },
    invalidated: { threw: "ChatGPT refresh failed: 401 refresh_token_invalidated." },
    badJwt: { threw: "ChatGPT refresh failed: a token ky can't read." },
    noExp: { threw: "ChatGPT refresh failed: the tokens name no account or expiry." },
    garbled: { threw: "ChatGPT refresh failed: an answer ky can't read." }
  } as const satisfies Record<(typeof REFRESH_ANSWERS)[number], Json>;

  it("refreshes to a login that keeps what the answer leaves out, or refuses in B's words", () =>
    fc.assert(
      fc.asyncProperty(fc.constantFrom(...REFRESH_ANSWERS), async (answer) => {
        const { world } = fresh();

        expect(await world.apply({ kind: "refreshLogin", answer })).toEqual(refreshed[answer]);
      }),
      runs()
    ));
});
