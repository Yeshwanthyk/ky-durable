import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

/**
 * The local stack: ky's web app and real Worker (src/tests/stack.ts) with
 * fakes at the outside boundary: a fake AI binding, a fake VibeProxy (the
 * Mac starts away; `POST /test/mac?up=1` brings it online), a fake Executor
 * and a fake browser. `pnpm stack` serves it on KY_STACK_PORT (default 8790),
 * behind a fake Access (src/tests/fake-access.ts). Every start gets fresh state in
 * a temporary directory.
 *
 * Ready when `GET /manifest.webmanifest` answers 200. Stop it with Ctrl-C or SIGTERM; the
 * state directory is left for inspection.
 */

const repo = path.resolve(import.meta.dirname, "../..");

const port = Number(process.env.KY_STACK_PORT ?? 8790);

/**
 * A scotty session's preview of this port (SCOTTY_HATCH is `https://{port}-<session>.<domain>`):
 * Vite answers only hosts it knows, and refuses any other with 403 ("Blocked request").
 */
const preview = process.env.SCOTTY_HATCH?.replace("{port}", String(port)).replace(/^https?:\/\//, "").split("/")[0];

const state = mkdtempSync(path.join(tmpdir(), "ky-stack-"));

console.log(`ky stack: state in ${state}`);

export default defineConfig({
  root: repo,
  plugins: [
    agents(),
    react(),
    cloudflare({
      configPath: path.join(repo, "src/tests/wrangler.jsonc"),
      persistState: { path: state },
      inspectorPort: false
    }),
    tailwindcss()
  ],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    ...(preview && { allowedHosts: [preview] })
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
