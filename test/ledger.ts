/**
 * The prune ledger: docs/migration/effect/prune-ledger.json, the tests the Effect migration deleted on
 * purpose. gate-baseline.json holds every test and scenario at B; one that held at B and is gone now
 * is a regression unless the ledger has it, with why it went and what proves its behavior now.
 *
 * `pnpm ledger` checks the ledger itself, and `pnpm check` runs it: each entry names a check and a
 * test B's baseline has, a census class, and what replaced it (an invariant or e2e test, a lint rule,
 * or the parity runs), and no test is listed twice.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Type, { type Static } from "typebox";
import { parseAs } from "../src/core/decode.ts";

const REPO = path.resolve(import.meta.dirname, "..");

export const LEDGER = path.join(REPO, "docs/migration/effect/prune-ledger.json");

const BASELINE = path.join(REPO, "gate-baseline.json");

/**
 * Why a test could go, by what test-census found in it:
 *   MOCK   mocked a ky module (vi.mock, vi.fn on one): rewritten as an invariant, or gone
 *   SCAN   read src and matched a regex: now a lint rule
 *   SLEEP  waited on real time: moved to TestClock, or gone
 *   COPY   matched the web app's wording: one per journey kept
 *   UNIT   imported a domain's internals: the parity runs cover it
 */
export const CLASSES = ["MOCK", "SCAN", "SLEEP", "COPY", "UNIT"] as const;

const Entry = Type.Object({
  check: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  class: Type.Union(CLASSES.map((each) => Type.Literal(each))),
  replacedBy: Type.String({ minLength: 1 })
});

export type Entry = Static<typeof Entry>;

const Ledger = Type.Array(Entry);

const Baseline = Type.Object({ items: Type.Array(Type.Object({ check: Type.String(), name: Type.String(), outcome: Type.String() })) });

/** The key gate.ts compares items by. */
export const keyOf = (item: { check: string; name: string }): string => `${item.check}\u0000${item.name}`;

export function readLedger(): Entry[] {
  return existsSync(LEDGER) ? parseAs(Ledger, readFileSync(LEDGER, "utf8"), path.relative(REPO, LEDGER)) : [];
}

/**
 * What's wrong with the ledger against B's baseline. `replacedBy` names a file (with `path > test`) or
 * a lint rule (`lint:<rule>`) or `parity:<domain>`; a file must exist.
 */
export function ledgerProblems(ledger: Entry[], baseline: { items: { check: string; name: string }[] }): string[] {
  const known = new Set(baseline.items.map(keyOf));
  const seen = new Set<string>();
  const problems: string[] = [];

  for (const entry of ledger) {
    const key = keyOf(entry);
    const where = `${entry.check}: "${entry.name}"`;

    if (!known.has(key)) problems.push(`${where} isn't in gate-baseline.json, so it can't have been pruned from B`);

    if (seen.has(key)) problems.push(`${where} is listed twice`);
    seen.add(key);
    const [target] = entry.replacedBy.split(" > ");

    if (target && !/^(lint|parity):/.test(target) && !existsSync(path.join(REPO, target))) problems.push(`${where} is replaced by ${target}, which doesn't exist`);
  }

  return problems;
}

type Outcome = { check: string; name: string; outcome: string };

/** Outcomes that held at B: a pass, or a failure the harness expects. */
export const GOOD = new Set(["passed", "PASS", "XFAIL"]);

const PASSING = new Set(["passed", "PASS"]);

/** Outcomes that are red now: a failure, or a harness XFAIL that started passing and needs its entry. */
const RED = new Set(["failed", "FAIL", "timedOut", "interrupted", "XPASS"]);

/**
 * What the ratchet refuses: an item that held at B and doesn't now, unless the ledger pruned it, and a
 * red item B never had, since a new test that fails is as red as an old one.
 */
export function regressions(baseline: Outcome[], now: Outcome[], pruned: Set<string>): string[] {
  const atB = new Set(baseline.map(keyOf));
  const current = new Map(now.map((item) => [keyOf(item), item.outcome]));
  const found: string[] = [];

  for (const item of baseline) {
    if (!GOOD.has(item.outcome)) continue;

    const outcome = current.get(keyOf(item));

    if (outcome === item.outcome || (outcome !== undefined && PASSING.has(outcome))) continue;

    if (outcome === undefined && pruned.has(keyOf(item))) continue;

    found.push(`${item.check}: "${item.name}" was ${item.outcome}, now ${outcome ?? "missing"}`);
  }

  for (const [key, outcome] of current) {
    if (atB.has(key) || !RED.has(outcome)) continue;

    const [check, name] = key.split("\u0000");

    found.push(`${check}: "${name}" is new since B and ${outcome}`);
  }

  return found;
}

if (import.meta.main) {
  const ledger = readLedger();
  const problems = ledgerProblems(ledger, parseAs(Baseline, readFileSync(BASELINE, "utf8"), "gate-baseline.json"));

  for (const problem of problems) console.log(`ledger: ${problem}`);

  if (problems.length > 0) process.exit(1);
  console.log(`ledger: ${ledger.length} pruned tests, each in B's baseline with what replaced it`);
}
