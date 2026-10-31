import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MachineInfo } from "../../src/protocol";
import type { ModelsBoundary } from "../../src/providers/contract";
import type { SourceHost } from "../../src/providers/endpoint";
import { SOURCES } from "../../src/providers/sources";
import { fakeAI } from "../fakes/ai";

/**
 * Each way models reach ky is one Source in src/providers/sources/, and the rest of ky knows them only
 * through that shape. These hold for every source on the list, so a new one is checked the day it's
 * added, and no other file can learn VibeProxy's name, id or port without failing here.
 */
const REPO = path.join(import.meta.dirname, "../..");

const PORT = 18_317;

const refuse = async () => new Response("no", { status: 503 });

const machine: MachineInfo = {
  name: "mac",
  online: true,
  seenAt: 0,
  reason: null,
  active: 0,
  state: "on",
  note: "",
  facts: {
    os: "darwin",
    chrome: false,
    repos: [],
    agents: { claude: { installed: false, signedIn: false }, codex: { installed: false, signedIn: false } },
    ports: [PORT],
    kind: "computer"
  },
  login: "own",
  cloud: null,
  sandbox: null
};

const boundary: ModelsBoundary = {
  ai: fakeAI(refuse),
  fetch: refuse,
  vibeProxy: { port: PORT, key: "key", tunnel: { binding: { fetch: refuse }, origin: "https://tunnel.example" } }
};

const host: SourceHost = {
  boundary,
  vault: { auth: async () => ({ apiKey: "key" }), put: async () => {}, remove: async () => {} },
  machines: { machines: () => [machine], online: () => true },
  pipe: { fetcher: () => refuse },
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

  it.each(SOURCES.map((source) => [source.kind, source] as const))("%s places records of its own kind, and builds an endpoint for each", (kind, source) => {
    const live = source.start(host);

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

    expect(source.missing?.({ ...boundary, vibeProxy: { ...boundary.vibeProxy, tunnel: undefined } }, ids) ?? []).toEqual([]);
  });
});

/** ky's own source files, less its tests. */
function sources(dir: string): string[] {
  return readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === "tests" ? [] : sources(at);

    return /\.tsx?$/.test(entry.name) ? [at] : [];
  });
}

/** What only the VibeProxy source may know: its id, its port, its constants and how it's reached. */
const VIBEPROXY = /"vibeproxy"|VIBEPROXY_(PROVIDER|PORT|NAME|NOT_SET_UP|OFFER)|\b8317\b|vibeProxyRecord|tunnelPort/;

/** Files that still know it, each with why. Keep this short; it should only shrink. */
const KNOWN = {
  "src/ui/Panel.tsx": "the Settings Status card names VibeProxy until it shows the main model's provider instead"
} as const satisfies Readonly<Record<string, string>>;

it("keeps VibeProxy's id, port and constants inside its source", () => {
  const leaks = sources("src").filter((file) => file !== "src/providers/sources/vibeproxy.ts" && !(file in KNOWN) && VIBEPROXY.test(readFileSync(path.join(REPO, file), "utf8")));

  expect(leaks).toEqual([]);
});

it("lists only files that still know VibeProxy as known", () => {
  expect(Object.keys(KNOWN).filter((file) => !VIBEPROXY.test(readFileSync(path.join(REPO, file), "utf8")))).toEqual([]);
});
