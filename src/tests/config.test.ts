import { env } from "cloudflare:test";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { describe, expect, it } from "vitest";
import { peerLimits } from "../peers/peers";
import { apiKey, VENDORS } from "../providers/sources/api-keys";
import { missing } from "../providers/offer";
import { notSetUp, PiAgent } from "../server";

/** What production builds from a deploy's config: the real boundaryFor. */
function boundary(config: Env) {
  return PiAgent.prototype.boundaryFor.call(undefined, config);
}

describe("a deploy's config", () => {
  it("seeds a new ky, and lists nothing as not set up", () => {
    const built = boundary(env);

    expect(built.seeds).toBe(true);
    expect(notSetUp(built)).toEqual([]);
  });

  it("finds every featured and light model in pi-ai's catalog, so a pi-ai that drops one fails here", () => {
    for (const vendor of VENDORS) expect(missing(vendor.provider().getModels(), vendor.offer)).toEqual([]);
  });

  it("offers OpenCode Go's first model once pi-ai no longer has ky's", () => {
    const vendor = { ...VENDORS.find((each) => each.id === "opencode-go")!, offer: { featured: ["no-such-model"] } };
    const endpoint = apiKey(vendor, fetch, async () => null, () => 0);

    expect(endpoint.featured).toEqual([opencodeGoProvider().getModels()[0]]);
  });

  it("caps a peer's asks at 3 open and 10 an hour unless the overlay's vars say", () => {
    expect(peerLimits({})).toEqual({ openAsks: 3, hourlyAsks: 10 });
    expect(peerLimits({ KY_PEER_OPEN_ASKS: "5", KY_PEER_HOURLY_ASKS: "40" })).toEqual({ openAsks: 5, hourlyAsks: 40 });

    for (const bad of ["", " ", "0", "-2", "1.5", "lots"]) expect(peerLimits({ KY_PEER_OPEN_ASKS: bad }).openAsks).toBe(3);
  });
});
