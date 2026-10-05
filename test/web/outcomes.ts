import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * A Playwright reporter that writes one `{ name, outcome }` per test to
 * test-results/web-outcomes.json, flat, for `pnpm gate` to compare with
 * gate-baseline.json.
 */
export default class Outcomes implements Reporter {
  readonly #outcomes: Array<{ name: string; outcome: string }> = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    this.#outcomes.push({ name: test.titlePath().slice(3).join(" > "), outcome: result.status });
  }

  onEnd(): void {
    const file = path.resolve(import.meta.dirname, "../../test-results/web-outcomes.json");

    mkdirSync(path.dirname(file), { recursive: true });

    writeFileSync(file, `${JSON.stringify(this.#outcomes, null, 2)}\n`);
  }
}
