import { env, SELF } from "cloudflare:test";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { describe, expect, it } from "vitest";
import { opencodeGo } from "../models";
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
  OPENCODE_API_KEY: "opencode-key",
  EXECUTOR_URL: "https://executor.test/mcp",
  EXECUTOR_TOKEN: "executor-token"
};

function boundary(config: Env) {
  return PiAgent.prototype.boundaryFor.call(undefined, config);
}

describe("a deploy's config", () => {
  it("builds VibeProxy and Executor when all their config is set", () => {
    const built = boundary(full);

    expect(built.vibeProxy).toMatchObject({ origin: "http://127.0.0.1:8317", key: "vibeproxy-key" });
    expect(built.executor).toEqual({ url: "https://executor.test/mcp", token: "executor-token" });
    expect(notSetUp(built)).toEqual([]);
  });

  for (const name of OPTIONAL) {
    const service = name.startsWith("VIBEPROXY") ? "vibeProxy" : "executor";

    it(`leaves out ${service} without ${name}, or with it empty`, () => {
      const { [name]: _left, ...without } = full;

      for (const config of [without, { ...full, [name]: "" }]) {
        const built = boundary(config);

        expect(built[service]).toBeUndefined();
        expect(notSetUp(built).map((each) => each.id)).toEqual([service.toLowerCase()]);
      }
    });
  }

  it("keeps OpenCode Go without its key, as not set up", () => {
    const { OPENCODE_API_KEY: _key, ...without } = full;

    expect(notSetUp(boundary(without))).toEqual([
      { id: "opencode-go", name: "OpenCode Go", needs: "the OPENCODE_API_KEY secret" }
    ]);
  });

  it("offers OpenCode Go's first model once pi-ai no longer has ky's", () => {
    expect(opencodeGo("opencode-key", "no-such-model").models).toEqual([opencodeGoProvider().getModels()[0]]);
  });
});
