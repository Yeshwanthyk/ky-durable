import type { EnvironmentOptions } from "vite";

/** Packages only lazy chunks import; see `codeSplitting` below. */
const LAZY = /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(shiki|@shikijs|@pierre|@streamdown\/code|oniguruma-[^/]+|diff|mermaid|katex)\//;

/**
 * The browser's bundle, shared by the deploy (vite.config.ts) and the local stack (test/stack/vite.config.ts),
 * so a stack measured with strobe loads the chunks production ships. The Worker's stays one file.
 *
 * strobe builds with STROBE_SOURCEMAP=hidden: maps beside each script with no `sourceMappingURL`, so the
 * scripts are byte for byte the deploy's. Unset, as in a deploy, there are none.
 */
export const client: EnvironmentOptions = {
  build: {
    sourcemap: process.env.STROBE_SOURCEMAP === "hidden" ? "hidden" : false,
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
};
