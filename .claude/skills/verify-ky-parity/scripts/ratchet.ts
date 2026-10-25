/**
 * `node --experimental-strip-types .claude/skills/verify-ky-parity/scripts/ratchet.ts <domain>`
 *
 * The ratchet for one domain, without the whole gate: runs the domain's test files (from
 * `pnpm census <domain>`), and fails when a test in those files that held at B
 * (gate-baseline.json) is now failing or gone, unless the prune ledger deleted it on purpose.
 * Writes test-results/parity/<domain>/ratchet.json.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { GOOD, keyOf, ledgerProblems, readLedger, regressions } from "../../../../test/ledger.ts";

const REPO = path.resolve(import.meta.dirname, "../../../..");

type Item = { check: string; name: string; outcome: string; file?: string };

/** Which gate check runs a test file, and its vitest config. */
const CHECKS = [
  { check: "worker-e2e", prefix: "src/tests/", config: "src/tests/vitest.config.ts" },
  { check: "node", prefix: "test/node/", config: "test/node/vitest.config.ts" },
  { check: "invariants", prefix: "test/invariants/", config: "test/invariants/vitest.config.ts" },
  { check: "invariants", prefix: "test/parity/", config: "test/invariants/vitest.config.ts" }
];

const domain = process.argv[2];

if (!domain) {
  console.error("usage: ratchet.ts <domain>");
  process.exit(2);
}

const OUT = path.join(REPO, "test-results/parity", domain);

mkdirSync(OUT, { recursive: true });

const census = spawnSync("pnpm", ["-s", "census", domain], { cwd: REPO, encoding: "utf8" });

if (census.status !== 0) throw new Error(`pnpm census ${domain} failed:\n${census.stderr}`);

const rows = (JSON.parse(readFileSync(path.join(REPO, "test-results/census", `${domain}.json`), "utf8")) as { rows: { file: string }[] }).rows;
const files = rows.map((row) => row.file);
const baseline = JSON.parse(readFileSync(path.join(REPO, "gate-baseline.json"), "utf8")) as { items: Item[] };
const unfiled = baseline.items.filter((item) => item.file === undefined && item.check !== "harness" && item.check !== "web");

if (unfiled.length > 0) throw new Error("gate-baseline.json has vitest items without a file: re-record it with the current test/gate.ts");

const now: Item[] = [];

for (const { check, prefix, config } of CHECKS) {
  const mine = files.filter((file) => file.startsWith(prefix));

  if (mine.length === 0) continue;

  const report = path.join(OUT, `ratchet-${check}-${prefix.split("/")[1]}.vitest.json`);

  rmSync(report, { force: true });
  spawnSync("pnpm", ["exec", "vitest", "run", "--config", config, "--reporter=json", `--outputFile=${report}`, ...mine], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (!existsSync(report)) throw new Error(`vitest wrote no report for ${check}: ${mine.join(" ")}`);

  const results = (JSON.parse(readFileSync(report, "utf8")) as { testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[] }).testResults;

  for (const each of results) for (const test of each.assertionResults) now.push({ check, name: test.fullName, outcome: test.status, file: path.relative(REPO, each.name) });
}

const ledger = readLedger();
const unfit = ledgerProblems(ledger, baseline);
const pruned = new Set(ledger.map(keyOf));
const held = baseline.items.filter((item) => item.file !== undefined && files.includes(item.file) && GOOD.has(item.outcome));
const lost = regressions(baseline.items.filter((item) => item.file !== undefined && files.includes(item.file)), now, pruned);

const atB = baseline.items.filter((item) => item.file !== undefined && files.includes(item.file));
const redAtB = atB.filter((item) => !GOOD.has(item.outcome)).map((item) => `${item.file}: ${item.name}`);
const holds = lost.length === 0 && unfit.length === 0;

writeFileSync(path.join(OUT, "ratchet.json"), `${JSON.stringify({ domain, at: new Date().toISOString(), files, held: held.length, now: now.length, redAtB, ledgerProblems: unfit, lost, holds }, null, 2)}\n`);

for (const line of [...unfit, ...lost]) console.log(`  ${line}`);

console.log(`${holds ? "PASS" : "FAIL"}  ${domain} ratchet: ${held.length} tests held at B in ${files.length} files, ${lost.length} lost, ${redAtB.length} red at B already`);

process.exit(holds ? 0 : 1);
