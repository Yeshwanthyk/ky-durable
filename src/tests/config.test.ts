import { env, SELF } from "cloudflare:test";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { describe, expect, it } from "vitest";
import { apiKey, VENDORS } from "../providers/api-key";
import { notSetUp, PiAgent } from "../server";

/**
 * What production builds from a deploy's config: the real boundaryFor, on an
 * env with each optional var, binding or secret left out or empty.
 */
const OPTIONAL = ["VIBEPROXY", "VIBEPROXY_ORIGIN", "VIBEPROXY_KEY", "EXECUTOR_URL", "EXECUTOR_TOKEN"] as const;

const full: Env = {
  ...env,
  // Any Fetcher stands in for the tunnel: boundaryFor only passes it on.
  VIBEPROXY: SELF,
  VIBEPROXY_ORIGIN: "http://127.0.0.1:8317",
  VIBEPROXY_KEY: "vibeproxy-key",
  EXECUTOR_URL: "https://executor.test/mcp",
  EXECUTOR_TOKEN: "executor-token"
};

function boundary(config: Env) {
  return PiAgent.prototype.boundaryFor.call(undefined, config);
}

describe("a deploy's config", () => {
  it("builds VibeProxy and Executor when all their config is set", () => {
    const built = boundary(full);

    expect(built.vibeProxy).toMatchObject({ port: 8317, key: "vibeproxy-key", tunnel: { origin: "http://127.0.0.1:8317" } });
    expect(built.executor).toEqual({ url: "https://executor.test/mcp", token: "executor-token" });
    expect(notSetUp(built)).toEqual([]);
  });

  for (const name of OPTIONAL) {
    const vibeProxy = name.startsWith("VIBEPROXY");

    it(`leaves out ${vibeProxy ? "VibeProxy's tunnel" : "Executor"} without ${name}, or with it empty`, () => {
      const { [name]: _left, ...without } = full;

      for (const config of [without, { ...full, [name]: "" }]) {
        const built = boundary(config);

        expect(vibeProxy ? built.vibeProxy.tunnel : built.executor).toBeUndefined();
        expect(notSetUp(built).map((each) => each.id)).toEqual([vibeProxy ? "vibeproxy" : "executor"]);
      }
    });
  }

  it("counts VibeProxy as set up without the tunnel while a machine shares it", () => {
    const { VIBEPROXY: _tunnel, ...without } = full;

    expect(notSetUp(boundary(without), ["vibeproxy"])).toEqual([]);
  });

  it("offers OpenCode Go's first model once pi-ai no longer has ky's", () => {
    const vendor = { ...VENDORS.find((each) => each.id === "opencode-go")!, modelIds: ["no-such-model"] };

    expect(apiKey(vendor, fetch, async () => null).models).toEqual([opencodeGoProvider().getModels()[0]]);
  });
});
