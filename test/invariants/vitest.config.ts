import path from "node:path";
import { defineConfig } from "vitest/config";

/** What must stay true of ky's contracts however the code around them changes. `pnpm test:invariants`, part of `pnpm check`. */
export default defineConfig({
  test: {
    name: "invariants",
    environment: "node",
    include: [path.join(import.meta.dirname, "**/*.test.ts")]
  }
});
