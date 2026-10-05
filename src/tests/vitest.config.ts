import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { fakeVibeProxy, refusingVibeProxy } from "./fake-vibeproxy.ts";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") },
      // The Mac's VibeProxy tunnel: away (refuses connections) and online.
      miniflare: { serviceBindings: { VIBEPROXY: refusingVibeProxy, VIBEPROXY_UP: fakeVibeProxy } }
    })
  ],
  resolve: {
    // Resolve every pi package from this example, so the harness and the
    // tests share one copy of pi's module state.
    dedupe: [
      "@earendil-works/chord",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-durable",
      "@earendil-works/pi-telemetry"
    ]
  },
  test: {
    name: "next-pi-harness",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
