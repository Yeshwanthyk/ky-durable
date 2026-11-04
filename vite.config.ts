import { existsSync } from "node:fs";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";
import { precache } from "./sw-precache";
import { client } from "./vite.client";
import { experimental_readRawConfig } from "wrangler";
import { applyOverlay } from "./wrangler-overlay";

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
    tailwindcss(),
    // The service worker caches the whole build on install (public/sw.js).
    precache()
  ],
  environments: {
    // The browser's bundle only; the Worker's stays one file.
    client
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
