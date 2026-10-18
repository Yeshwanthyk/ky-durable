import path from "node:path";
import { defineConfig } from "vitest/config";

/** What must stay true of ky's contracts however the code around them changes. `pnpm test:invariants`, part of `pnpm check`. */
export default defineConfig({
  test: {
    name: "invariants",
    environment: "node",
    // Generated runs are bound by CPU: what takes half a second on a laptop takes over five on a one-CPU container.
    testTimeout: 30_000,
    include: [path.join(import.meta.dirname, "**/*.test.ts")]
  }
});
