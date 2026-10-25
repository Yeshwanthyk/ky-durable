import path from "node:path";
import { defineConfig } from "vitest/config";

/** What must stay true of ky's contracts however the code around them changes. `pnpm test:invariants`, part of `pnpm check`. */
export default defineConfig({
  test: {
    name: "invariants",
    environment: "node",
    // Generated runs are bound by CPU: what takes half a second on a laptop takes over five on a one-CPU container.
    testTimeout: 30_000,
    // test/parity: the parity kit's own proof, and each domain's legacy-against-port runs while it's ported.
    include: [path.join(import.meta.dirname, "**/*.test.ts"), path.join(import.meta.dirname, "../parity/**/*.test.ts")]
  }
});
