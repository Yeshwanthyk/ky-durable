import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    // Docs: explainer pages and mx video scenes, not shipped code.
    "explainers/**",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
    "dist/**",
    // The gate's outputs: Playwright reports, traces and harness logs.
    "test-results/**",
    "env.d.ts",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "ky", specifier: "./tools/oxlint/ky/index.ts" },
  ],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    // Nothing unchecked enters typed: untrusted JSON goes through src/core/decode.ts, and `any`
    // (from a parse, a vendor's types or a missing annotation) can't flow into typed code.
    "ky/no-unchecked-parse": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    // A lookup that can miss says what it expected, with must() from src/core/must.ts.
    "typescript/no-non-null-assertion": "error"
  },
  overrides: [
    {
      // Tests, fakes and harnesses drive ky from outside: they may assert what they just set up.
      files: ["src/tests/**", "test/**", "tools/**/*.test.ts"],
      rules: { "ky/no-unchecked-parse": "off", "typescript/no-non-null-assertion": "off" }
    },
    {
      // Plain JavaScript has no types to check.
      files: ["**/*.js"],
      rules: {
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off"
      }
    }
  ]
});
