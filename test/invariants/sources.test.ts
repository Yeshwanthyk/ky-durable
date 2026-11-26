import { describe, expect, it } from "vitest";
import type { ModelsBoundary } from "../../src/providers/contract";
import type { SourceHost } from "../../src/providers/endpoint";
import { SOURCES } from "../../src/providers/sources";
import { fakeAI } from "../fakes/ai";

/**
 * Each way models reach ky is one Source in src/providers/sources/, and the rest of ky knows them only
 * through that shape. These hold for every source on the list, so a new one is checked the day it's added.
 */
const refuse = async () => new Response("no", { status: 503 });

const boundary: ModelsBoundary = {
  ai: fakeAI(refuse),
  fetch: refuse,
  claudeCloud: refuse
};

const host: SourceHost = {
  boundary,
  vault: { auth: async () => ({ apiKey: "key" }), put: async () => {}, remove: async () => {}, chatgptToken: async () => ({ accessToken: "token" }), claudeToken: async () => ({ oauthToken: "sk-ant-oat-test" }) },
  now: () => 0,
  changed: () => {}
};

describe("model sources", () => {
  it("each builds its own kind of record, and sorts in its own place", () => {
    expect(new Set(SOURCES.map((source) => source.kind)).size).toBe(SOURCES.length);
    expect(new Set(SOURCES.map((source) => source.priority)).size).toBe(SOURCES.length);
  });

  it("runs background work on one source at most", () => {
    expect(SOURCES.filter((source) => source.background).length).toBeLessThanOrEqual(1);
  });

  it.each(SOURCES.map((source) => [source.kind, source] as const))("%s places records of its own kind, and builds an endpoint for each", async (kind, source) => {
    const live = source.start(host);

    await live.check?.();

    for (const record of live.place()) {
      expect(record.kind).toBe(kind);
      const endpoint = live.build(record);

      expect(endpoint?.kind).toBe(kind);
      expect(endpoint?.provider.id).toBe(record.id);
      expect(endpoint?.featured.length).toBeGreaterThan(0);
      expect(endpoint?.needs).not.toBe("");
    }
  });

  it.each(SOURCES.map((source) => [source.kind, source] as const))("%s lists nothing as missing once its provider is there", (_kind, source) => {
    const ids = source
      .start(host)
      .place()
      .map((record) => record.id);

    expect(source.missing?.(boundary, ids) ?? []).toEqual([]);
  });
});
