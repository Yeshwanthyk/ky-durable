import { env, SELF } from "cloudflare:test";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { describe, expect, it } from "vitest";
import { apiKey, VENDORS } from "../providers/api-key";
import { notSetUp, PiAgent } from "../server";

/**
 * What production builds from a deploy's config: the real boundaryFor, on an
 * env with each optional var, binding or secret left out or empty.
 */
const OPTIONAL = ["VIBEPROXY", "VIBEPROXY_ORIGIN", "VIBEPROXY_KEY"] as const;

const full: Env = {
  ...env,
  // Any Fetcher stands in for the tunnel: boundaryFor only passes it on.
  VIBEPROXY: SELF,
  VIBEPROXY_ORIGIN: "http://127.0.0.1:8317",
  VIBEPROXY_KEY: "vibeproxy-key"
};

function boundary(config: Env) {
  return PiAgent.prototype.boundaryFor.call(undefined, config);
}

describe("a deploy's config", () => {
  it("builds VibeProxy when all its config is set, and seeds a new ky", () => {
    const built = boundary(full);

    expect(built.vibeProxy).toMatchObject({ port: 8317, key: "vibeproxy-key", tunnel: { origin: "http://127.0.0.1:8317" } });
    expect(built.seeds).toBe(true);
    expect(notSetUp(built)).toEqual([]);
  });

  for (const name of OPTIONAL) {
    it(`leaves out VibeProxy's tunnel without ${name}, or with it empty`, () => {
      const { [name]: _left, ...without } = full;

      for (const config of [without, { ...full, [name]: "" }]) {
        const built = boundary(config);

        expect(built.vibeProxy.tunnel).toBeUndefined();
        expect(notSetUp(built).map((each) => each.id)).toEqual(["vibeproxy"]);
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
