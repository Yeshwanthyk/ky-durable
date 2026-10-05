import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { startExecutor } from "../../test/fakes/executor.ts";

const testsDir = import.meta.dirname;

// The fake Executor runs in this Node process for the whole run; ky's real MCP client reaches it over HTTP.
const executor = await startExecutor();

executor.server.unref();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") },
      miniflare: { bindings: { EXECUTOR_URL: executor.url } }
    })
  ],
  resolve: {
    // Resolve every pi package from this project, so the harness and the
    // tests share one copy of pi's module state.
    dedupe: [
      "@earendil-works/chord",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-durable",
      "@earendil-works/pi-telemetry"
    ]
  },
  test: {
    name: "worker-e2e",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
