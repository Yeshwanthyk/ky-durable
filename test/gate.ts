#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * The gate: `pnpm gate`. Runs every check in order and stops at the first
 * that fails:
 *
 *   typecheck   the Worker (tsconfig.json) and the runner, harness and
 *               Playwright code (tsconfig.node.json)
 *   lint        oxlint with the anti-slop rules, no errors and no warnings
 *   fallow      dead code, duplication and complexity, no finding beyond
 *               the ones saved in fallow/*.json (which may only shrink)
 *   worker-e2e  vitest-pool-workers on the real PiAgent (`pnpm test`)
 *   harness     the CLI harness with a real runner (`pnpm harness all`)
 *   web         Playwright on the real web app (`pnpm test:web`)
 *
 * Then it compares each test and scenario with gate-baseline.json: one that
 * passed (or, for a trap, was XFAIL) at the baseline must still be there and
 * still pass, or the gate fails even though every command exited 0. A trap
 * that now passes is fine. `pnpm gate --record` rewrites the baseline after a
 * passing run; review its diff, since dropping a line drops a check.
 *
 * Logs go to test-results/gate/<check>.log.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const REPO = path.resolve(import.meta.dirname, "..");

const OUT = path.join(REPO, "test-results/gate");

const BASELINE = path.join(REPO, "gate-baseline.json");

const FALLOW = ["npx", "-y", "fallow@3.31"];

const Item = Type.Object({ check: Type.String(), name: Type.String(), outcome: Type.String() });

type Item = Static<typeof Item>;

const Baseline = Type.Object({ checks: Type.Array(Type.String()), items: Type.Array(Item) });

type Baseline = Static<typeof Baseline>;

/** The part of vitest's JSON report the gate reads. */
const VitestReport = Type.Object({
  testResults: Type.Array(
    Type.Object({ assertionResults: Type.Array(Type.Object({ fullName: Type.String(), status: Type.String() })) })
  )
});

const Outcomes = Type.Array(Type.Object({ name: Type.String(), outcome: Type.String() }));

type Check = {
  name: string;
  commands: string[][];
  /** The tests or scenarios the check ran, read from its report. */
  items?: () => Item[];
};

/** The JSON file `file` if it exists and matches `schema`. */
function decode<Schema extends TSchema>(schema: Schema, file: string): Static<Schema> | undefined {
  if (!existsSync(file)) return undefined;

  const value = JSON.parse(readFileSync(file, "utf8"));

  return Value.Check(schema, value) ? value : undefined;
}

function outcomesOf(check: string, file: string): Item[] {
  const report = decode(Outcomes, file);

  if (!report) throw new Error(`${file} is missing or not a list of outcomes`);

  return report.map(({ name, outcome }) => ({ check, name, outcome }));
}

const CHECKS: Check[] = [
  { name: "typecheck", commands: [["pnpm", "-s", "typecheck"]] },
  { name: "lint", commands: [["pnpm", "-s", "lint", "--max-warnings=0"]] },
  {
    name: "fallow",
    commands: ["dead-code", "dupes", "health"].map((analysis) => [
      ...FALLOW,
      analysis,
      "--quiet",
      "--baseline",
      `fallow/${analysis}.json`
    ])
  },
  {
    name: "worker-e2e",
    commands: [["pnpm", "-s", "test", "--reporter=default", "--reporter=json", "--outputFile.json=test-results/worker-e2e.json"]],
    items: () => {
      const report = decode(VitestReport, path.join(REPO, "test-results/worker-e2e.json"));

      if (!report) throw new Error("test-results/worker-e2e.json is missing or not vitest's JSON report");

      return report.testResults.flatMap((file) =>
        file.assertionResults.map((test) => ({ check: "worker-e2e", name: test.fullName, outcome: test.status }))
      );
    }
  },
  {
    name: "harness",
    commands: [["pnpm", "-s", "harness", "all"]],
    items: () => outcomesOf("harness", path.join(REPO, "test-results/harness/results.json"))
  },
  {
    name: "web",
    commands: [["pnpm", "-s", "test:web"]],
    items: () => outcomesOf("web", path.join(REPO, "test-results/web-outcomes.json"))
  }
];

/** Outcomes that count as the check holding. */
const GOOD = new Set(["passed", "PASS", "XFAIL"]);

const PASSING = new Set(["passed", "PASS"]);

function run(command: string[], log: string): Promise<number> {
  return new Promise((resolve) => {
    const out = createWriteStream(log, { flags: "a" });

    out.write(`$ ${command.join(" ")}\n`);

    const child = spawn(command[0]!, command.slice(1), { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.pipe(out, { end: false });

    child.stderr.pipe(out, { end: false });

    child.on("close", (code) => {
      out.end();
      resolve(code ?? 1);
    });
  });
}

function tail(log: string, lines = 40): string {
  return readFileSync(log, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

/** Baseline items that held then and do not now. */
function regressions(baseline: Baseline, now: Item[]): string[] {
  const current = new Map(now.map((item) => [`${item.check}\u0000${item.name}`, item.outcome]));
  const found: string[] = [];

  for (const item of baseline.items) {
    if (!GOOD.has(item.outcome)) continue;

    const outcome = current.get(`${item.check}\u0000${item.name}`);

    if (outcome === item.outcome || (outcome !== undefined && PASSING.has(outcome))) continue;

    found.push(`${item.check}: "${item.name}" was ${item.outcome}, now ${outcome ?? "missing"}`);
  }

  return found;
}

const record = process.argv.includes("--record");

mkdirSync(OUT, { recursive: true });

const items: Item[] = [];

for (const check of CHECKS) {
  const log = path.join(OUT, `${check.name}.log`);
  const started = Date.now();

  writeFileSync(log, "");

  let code = 0;

  for (const command of check.commands) {
    code = await run(command, log);

    if (code !== 0) break;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1).padStart(6);

  if (code !== 0) {
    console.log(`FAIL  ${check.name.padEnd(11)} ${seconds}s  (exit ${code}, ${path.relative(REPO, log)})`);
    console.log(tail(log));
    process.exit(1);
  }

  const ran = check.items?.() ?? [];

  items.push(...ran);
  console.log(`PASS  ${check.name.padEnd(11)} ${seconds}s${ran.length > 0 ? `  ${ran.length} checks` : ""}`);
}

if (record) {
  const baseline: Baseline = { checks: CHECKS.map((check) => check.name), items };

  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Recorded ${items.length} checks in ${path.relative(REPO, BASELINE)}.`);
  process.exit(0);
}

const saved = decode(Baseline, BASELINE);

if (!saved) {
  console.log("FAIL  baseline     gate-baseline.json is missing or malformed: run `pnpm gate --record` once and commit it");
  process.exit(1);
}

const lost = regressions(saved, items);

if (lost.length > 0) {
  console.log(`FAIL  baseline     ${lost.length} regressed against gate-baseline.json:`);

  for (const line of lost) console.log(`  ${line}`);
  process.exit(1);
}

console.log(`PASS  baseline     ${saved.items.length} baseline checks hold`);
