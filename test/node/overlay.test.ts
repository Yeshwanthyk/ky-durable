import path from "node:path";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { applyOverlay } from "../../wrangler-overlay";

const REPO = path.resolve(import.meta.dirname, "../..");

const read = (file: string) => experimental_readRawConfig({ config: path.join(REPO, file) }).rawConfig;

describe("the owner overlay", () => {
  it("adds the example overlay's vars and VibeProxy tunnel to wrangler.jsonc and keeps its bindings", () => {
    const config = read("wrangler.jsonc");
    const buckets = config.r2_buckets;
    applyOverlay(config, read("wrangler.local.example.jsonc"));

    expect(config).toMatchObject({
      vars: {
        VIBEPROXY_ORIGIN: "http://127.0.0.1:8317"
      },
      vpc_services: [{ binding: "VIBEPROXY", remote: true }],
      ai: { binding: "AI", remote: true },
      r2_buckets: buckets
    });
  });

  it("merges vars, adds VPC services, and lets anything else replace wrangler.jsonc's", () => {
    const vpc = (binding: string) => ({ binding, service_id: binding.toLowerCase() });
    const config = { name: "ky", vars: { A: "1", B: "2" }, vpc_services: [vpc("ONE")], ai: { binding: "AI" } };

    applyOverlay(config, { name: "mine", vars: { B: "3" }, vpc_services: [vpc("TWO")] });

    expect(config).toEqual({
      name: "mine",
      vars: { A: "1", B: "3" },
      vpc_services: [vpc("ONE"), vpc("TWO")],
      ai: { binding: "AI" }
    });
  });
});
