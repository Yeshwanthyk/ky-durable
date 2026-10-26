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
 *   node        vitest in Node on the build's config (`pnpm test:node`)
 *   worker-e2e  vitest-pool-workers on the real PiAgent (`pnpm test`)
 *   harness     the CLI harness with a real runner (`pnpm harness all`)
 *   web         Playwright on the real web app (`pnpm test:web`)
 *   invariants  the property and contract tests (`pnpm test:invariants`)
 *
 * The checks that report tests (node through invariants) are judged by the
 * baseline alone, not their exit code: B already fails some of its own tests
 * (flakes, a web locator, 9 invariants), so a red test that was red at B can't
 * stop the gate, and one that passed at B must still pass.
 *
 * Then it compares each test and scenario with gate-baseline.json: one that
 * passed (or, for a trap, was XFAIL) at the baseline must still be there and
 * still pass, or the gate fails even though every command exited 0. A trap
 * that now passes is fine. One deleted on purpose is excused only by an entry
 * in the prune ledger (docs/migration/effect/prune-ledger.json, test/ledger.ts). `pnpm gate --record` rewrites the baseline after a
 * passing run; review its diff, since dropping a line drops a check.
 *
 * Logs go to test-results/gate/<check>.log.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { keyOf, ledgerProblems, readLedger, regressions } from "./ledger.ts";

const REPO = path.resolve(import.meta.dirname, "..");

const OUT = path.join(REPO, "test-results/gate");

const BASELINE = path.join(REPO, "gate-baseline.json");

const FALLOW = ["pnpm", "exec", "fallow"];

/** One test or scenario; `file` (a vitest test's, from the repo root) lets a domain find its own. */
const Item = Type.Object({ check: Type.String(), name: Type.String(), outcome: Type.String(), file: Type.Optional(Type.String()) });

type Item = Static<typeof Item>;

const Baseline = Type.Object({ checks: Type.Array(Type.String()), items: Type.Array(Item) });

type Baseline = Static<typeof Baseline>;

/** The part of vitest's JSON report the gate reads. */
const VitestReport = Type.Object({
  testResults: Type.Array(
    Type.Object({ name: Type.String(), assertionResults: Type.Array(Type.Object({ fullName: Type.String(), status: Type.String() })) })
  )
});

const Outcomes = Type.Array(Type.Object({ name: Type.String(), outcome: Type.String() }));

type Check = {
  name: string;
  commands: string[][];
  /** The tests or scenarios the check ran, read from its report. */
  items?: () => Item[];
  /** A nonzero exit doesn't stop the gate; the baseline comparison of its items judges it. */
  ratchetOnly?: boolean;
  /** The report `items` reads, deleted before the run so a stale one can't stand in for a crash. */
  report?: string;
};

/** The JSON file `file` if it exists and matches `schema`. */
function decode<Schema extends TSchema>(schema: Schema, file: string): Static<Schema> | undefined {
  if (!existsSync(file)) return undefined;

  const value = JSON.parse(readFileSync(file, "utf8"));

  return Value.Check(schema, value) ? value : undefined;
}

/** The tests a vitest run reported to `file` with `--reporter=json`. */
function vitestItems(check: string, file: string): Item[] {
  const report = decode(VitestReport, path.join(REPO, file));

  if (!report) throw new Error(`${file} is missing or not vitest's JSON report`);

  return report.testResults.flatMap((each) =>
    each.assertionResults.map((test) => ({ check, name: test.fullName, outcome: test.status, file: path.relative(REPO, each.name) }))
  );
}

/** The vitest run `script`, reporting to test-results/<name>.json. */
function vitest(name: string, script: string): Check {
  const file = `test-results/${name}.json`;

  return {
    name,
    commands: [["pnpm", "-s", script, "--reporter=default", "--reporter=json", `--outputFile.json=${file}`]],
    items: () => vitestItems(name, file),
    ratchetOnly: true,
    report: file
  };
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
  vitest("node", "test:node"),
  vitest("worker-e2e", "test"),
  {
    name: "harness",
    commands: [["pnpm", "-s", "harness", "all"]],
    items: () => outcomesOf("harness", path.join(REPO, "test-results/harness/results.json")),
    ratchetOnly: true,
    report: "test-results/harness/results.json"
  },
  {
    name: "web",
    commands: [["pnpm", "-s", "test:web"]],
    items: () => outcomesOf("web", path.join(REPO, "test-results/web-outcomes.json")),
    ratchetOnly: true,
    report: "test-results/web-outcomes.json"
  },
  vitest("invariants", "test:invariants")
];

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

const record = process.argv.includes("--record");

mkdirSync(OUT, { recursive: true });

const items: Item[] = [];

for (const check of CHECKS) {
  const log = path.join(OUT, `${check.name}.log`);
  const started = Date.now();

  writeFileSync(log, "");

  if (check.report) rmSync(path.join(REPO, check.report), { force: true });

  let code = 0;

  for (const command of check.commands) {
    code = await run(command, log);

    if (code !== 0) break;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1).padStart(6);

  if (code !== 0 && !check.ratchetOnly) {
    console.log(`FAIL  ${check.name.padEnd(11)} ${seconds}s  (exit ${code}, ${path.relative(REPO, log)})`);
    console.log(tail(log));
    process.exit(1);
  }

  let ran: Item[];

  try {
    ran = check.items?.() ?? [];
  } catch (error) {
    console.log(`FAIL  ${check.name.padEnd(11)} ${seconds}s  (exit ${code}, no report: ${String(error)}; ${path.relative(REPO, log)})`);
    console.log(tail(log));
    process.exit(1);
  }

  items.push(...ran);

  const verdict = code === 0 ? "PASS" : "RAN ";

  console.log(`${verdict}  ${check.name.padEnd(11)} ${seconds}s${ran.length > 0 ? `  ${ran.length} checks` : ""}${code === 0 ? "" : `  (exit ${code}: judged by the baseline)`}`);
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

const ledger = readLedger();

const unfit = ledgerProblems(ledger, saved);

if (unfit.length > 0) {
  console.log(`FAIL  ledger       ${unfit.length} entries in the prune ledger don't hold:`);

  for (const line of unfit) console.log(`  ${line}`);
  process.exit(1);
}

const lost = regressions(saved.items, items, new Set(ledger.map(keyOf)));

if (lost.length > 0) {
  console.log(`FAIL  baseline     ${lost.length} regressed against gate-baseline.json, or are new and red:`);

  for (const line of lost) console.log(`  ${line}`);
  process.exit(1);
}

console.log(`PASS  baseline     ${saved.items.length} baseline checks hold${ledger.length > 0 ? `, ${ledger.length} pruned by the ledger` : ""}`);
