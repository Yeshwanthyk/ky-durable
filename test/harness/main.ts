#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * The CLI harness: `pnpm harness <scenario...|all>`, `pnpm harness --list`.
 *
 * Starts the local stack (or uses KY_STACK_URL), then runs each scenario
 * against it with a real runner and the fake claude, and prints one line per
 * scenario: PASS, FAIL, XFAIL (an expected-fail trap still fails) or XPASS
 * (a trap now holds: mark it `pass`). Exits non-zero on any FAIL or XPASS.
 * Logs, runner output and fake-claude logs go to test-results/harness/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connect } from "./client.ts";
import { machine } from "./runner.ts";
import { type Context, online, SCENARIOS, Violation } from "./scenarios.ts";
import { startProxy } from "./proxy.ts";
import { REPO, useStack } from "./stack.ts";

type Outcome = "PASS" | "FAIL" | "XFAIL" | "XPASS";

const SCENARIO_TIMEOUT_MS = 90_000;

const wanted = process.argv.slice(2);

if (wanted.includes("--list") || wanted.length === 0) {
  for (const scenario of SCENARIOS) console.log(`${scenario.name.padEnd(24)} ${scenario.expect.padEnd(6)} ${scenario.about}`);

  if (wanted.length === 0) console.log("\nusage: pnpm harness <scenario...|all>");
  process.exit(wanted.length === 0 ? 2 : 0);
}

const unknown = wanted.filter((name) => name !== "all" && !SCENARIOS.some((scenario) => scenario.name === name));

if (unknown.length > 0) {
  console.error(`Unknown scenario: ${unknown.join(", ")}. Try --list.`);
  process.exit(2);
}

const chosen = wanted.includes("all") ? SCENARIOS : SCENARIOS.filter((scenario) => wanted.includes(scenario.name));

const out = path.join(REPO, "test-results/harness");

const stack = await useStack(out);

const { url } = stack;

const results: Array<{ name: string; outcome: Outcome; detail: string; ms: number }> = [];

for (const scenario of SCENARIOS.filter((each) => chosen.includes(each))) {
  const dir = path.join(out, scenario.name);
  mkdirSync(dir, { recursive: true });
  const main = await connect(url);

  const context: Context = {
    url,
    dir,
    main,
    runner: undefined,
    cleanup: [],
    machine: async (name, env = {}) => {
      const proxy = await startProxy(url);
      context.cleanup.push(() => proxy.close());
      const each = machine(name, dir);
      context.runner = each.launch(proxy.url, env);
      await main.until(`${name} online`, () => online(context, name));

      return { machine: each, proxy };
    }
  };

  const started = Date.now();
  let outcome: Outcome;
  let detail = "";

  try {
    await Promise.race([
      scenario.run(context),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("scenario timed out")), SCENARIO_TIMEOUT_MS).unref())
    ]);

    outcome = scenario.expect === "pass" ? "PASS" : "XPASS";
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
    outcome = scenario.expect === "xfail" && error instanceof Violation ? "XFAIL" : "FAIL";
  }

  await context.runner?.stop();

  for (const clean of context.cleanup.reverse()) await clean();
  main.close();

  const ms = Date.now() - started;
  results.push({ name: scenario.name, outcome, detail, ms });
  console.log(`${outcome.padEnd(5)} ${scenario.name.padEnd(24)} ${(ms / 1000).toFixed(1).padStart(5)}s${detail ? `  ${detail}` : ""}`);
}

await stack.stop();

writeFileSync(path.join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

process.exit(results.some((result) => result.outcome === "FAIL" || result.outcome === "XPASS") ? 1 : 0);
