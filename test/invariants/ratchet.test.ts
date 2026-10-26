/**
 * The ratchet's rules (test/ledger.ts): what `pnpm gate` refuses against B's baseline, and what
 * `pnpm ledger` refuses in the prune ledger.
 */
import { describe, expect, it } from "vitest";
import { keyOf, ledgerProblems, regressions } from "../ledger.ts";

const item = (name: string, outcome: string) => ({ check: "node", name, outcome });

describe("regressions", () => {
  it("holds an item that kept its outcome, or now passes", () => {
    expect(regressions([item("a", "passed"), item("b", "XFAIL")], [item("a", "passed"), item("b", "PASS")], new Set())).toEqual([]);
  });

  it("refuses an item that held at B and now fails, is skipped or is gone", () => {
    expect(regressions([item("a", "passed"), item("b", "passed"), item("c", "passed")], [item("a", "failed"), item("b", "skipped")], new Set())).toEqual([
      'node: "a" was passed, now failed',
      'node: "b" was passed, now skipped',
      'node: "c" was passed, now missing'
    ]);
  });

  it("excuses a missing item only when the ledger pruned it", () => {
    expect(regressions([item("a", "passed")], [], new Set([keyOf(item("a", "passed"))]))).toEqual([]);
    expect(regressions([item("a", "passed")], [item("a", "failed")], new Set([keyOf(item("a", "passed"))]))).toEqual(['node: "a" was passed, now failed']);
  });

  it("leaves an item red at B alone, whatever it does now", () => {
    expect(regressions([item("a", "failed")], [item("a", "failed")], new Set())).toEqual([]);
  });

  it("refuses a new item that is red, and takes a new one that passes", () => {
    expect(regressions([], [item("new", "failed"), item("green", "passed"), item("flipped", "XPASS")], new Set())).toEqual([
      'node: "new" is new since B and failed',
      'node: "flipped" is new since B and XPASS'
    ]);
  });
});

describe("ledgerProblems", () => {
  const baseline = { items: [item("a", "passed"), item("b", "passed")] };
  const entry = (name: string, replacedBy: string) => ({ check: "node", name, class: "UNIT" as const, replacedBy });

  it("takes an entry for a B test replaced by an existing file, a lint rule or parity", () => {
    expect(ledgerProblems([entry("a", "test/invariants/deploy.test.ts > I-D1"), entry("b", "lint:no-sleep")], baseline)).toEqual([]);
    expect(ledgerProblems([entry("a", "parity:deploy")], baseline)).toEqual([]);
  });

  it("refuses a test B never had, one listed twice, and a replacement that doesn't exist", () => {
    expect(ledgerProblems([entry("z", "parity:deploy"), entry("a", "parity:deploy"), entry("a", "test/nowhere.test.ts > x")], baseline)).toEqual([
      `node: "z" isn't in gate-baseline.json, so it can't have been pruned from B`,
      'node: "a" is listed twice',
      'node: "a" is replaced by test/nowhere.test.ts, which doesn\'t exist'
    ]);
  });
});
