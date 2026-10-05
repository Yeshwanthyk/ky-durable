import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";
import { startExecutor } from "../fakes/executor.ts";

/**
 * The local stack: ky's web app and real Worker (src/tests/stack.ts) on pi-ai's
 * faux model, with the fake Executor beside it. `pnpm stack` serves it on
 * KY_STACK_PORT (default 8790), signed in with the token `ky-stack-token`.
 * Every start gets fresh state in a temporary directory.
 *
 * Ready when `GET /login` answers 200. Stop it with Ctrl-C or SIGTERM, which
 * also stops the fake Executor; the state directory is left for inspection.
 */

const repo = path.resolve(import.meta.dirname, "../..");

const executor = await startExecutor();

executor.server.unref();

const state = mkdtempSync(path.join(tmpdir(), "ky-stack-"));

console.log(`ky stack: fake executor at ${executor.url}, state in ${state}`);

export default defineConfig({
  root: repo,
  plugins: [
    agents(),
    react(),
    cloudflare({
      configPath: path.join(repo, "src/tests/wrangler.jsonc"),
      config: (config) => ({ vars: { ...config.vars, EXECUTOR_URL: executor.url } }),
      persistState: { path: state },
      inspectorPort: false
    }),
    tailwindcss()
  ],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.KY_STACK_PORT ?? 8790),
    strictPort: true
  },
  resolve: {
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
