import path from "node:path";
import { defineConfig } from "vitest/config";

/** Tests of what runs in Node rather than the Worker: the build's config. `pnpm test:node`. */
export default defineConfig({
  test: {
    name: "node",
    environment: "node",
    include: [path.join(import.meta.dirname, "**/*.test.ts")]
  }
});
