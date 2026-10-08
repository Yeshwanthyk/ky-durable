import { existsSync } from "node:fs";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";
import { experimental_readRawConfig } from "wrangler";
import { applyOverlay } from "./wrangler-overlay";

/** Packages only lazy chunks import; see `codeSplitting` below. */
const LAZY = /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(shiki|@shikijs|@pierre|@streamdown\/code|oniguruma-[^/]+|diff|mermaid|katex)\//;

/**
 * The owner overlay: this deploy's own vars and bindings, merged over the generic wrangler.jsonc. `pnpm start`
 * runs with it, and `pnpm run deploy` deploys the config `vite build` resolves with it.
 */
const OVERLAY = path.join(import.meta.dirname, "wrangler.local.jsonc");

export default defineConfig({
  plugins: [
    agents(),
    react(),
    cloudflare({
      inspectorPort: 9242,
      config: (config) => {
        if (existsSync(OVERLAY)) applyOverlay(config, experimental_readRawConfig({ config: OVERLAY }).rawConfig);
      }
    }),
    tailwindcss()
  ],
  environments: {
    // The browser's bundle only; the Worker's stays one file.
    client: {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              // Libraries change far less often than ky does, so they get their own
              // chunk and a deploy re-downloads only ky's code. What loads lazily
              // (Shiki with the first code fence, the diff viewer when Changes opens)
              // stays out of it, or the group would pull it into the first load.
              groups: [{ name: "vendor", test: (id) => id.includes("/node_modules/") && !LAZY.test(id) }]
            }
          }
        }
      }
    }
  },
  resolve: {
    // The commit-pinned pi artifacts intentionally omit sibling package
    // dependencies. Resolve every internal pi import from this example's
    // node_modules so one revision supplies all provider and harness types.
    dedupe: [
      "react",
      "react-dom",
      "@earendil-works/chord",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-durable",
      "@earendil-works/pi-telemetry"
    ]
  }
});
