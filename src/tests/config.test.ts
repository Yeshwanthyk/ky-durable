import { env, SELF } from "cloudflare:test";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { describe, expect, it } from "vitest";
import { peerLimits } from "../peers/peers";
import { apiKey, VENDORS } from "../providers/api-key";
import { missing } from "../providers/offer";
import { VIBEPROXY_OFFER } from "../providers/vibeproxy";
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

  it("finds every featured and light model in pi-ai's catalog, so a pi-ai that drops one fails here", () => {
    for (const vendor of VENDORS) expect(missing(vendor.provider().getModels(), vendor.offer)).toEqual([]);

    expect(missing(Object.values(ANTHROPIC_MODELS), VIBEPROXY_OFFER)).toEqual([]);
  });

  it("offers OpenCode Go's first model once pi-ai no longer has ky's", () => {
    const vendor = { ...VENDORS.find((each) => each.id === "opencode-go")!, offer: { featured: ["no-such-model"] } };
    const endpoint = apiKey(vendor, fetch, async () => null);

    expect(endpoint.featured).toEqual([opencodeGoProvider().getModels()[0]]);
  });

  it("caps a peer's asks at 3 open and 10 an hour unless the overlay's vars say", () => {
    expect(peerLimits({})).toEqual({ openAsks: 3, hourlyAsks: 10 });
    expect(peerLimits({ KY_PEER_OPEN_ASKS: "5", KY_PEER_HOURLY_ASKS: "40" })).toEqual({ openAsks: 5, hourlyAsks: 40 });

    for (const bad of ["", " ", "0", "-2", "1.5", "lots"]) expect(peerLimits({ KY_PEER_OPEN_ASKS: bad }).openAsks).toBe(3);
  });
});
