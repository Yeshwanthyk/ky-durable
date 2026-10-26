# Writer brief (Waves 4–8)

You are a delegate of the COS for ky's move to Effect v4. Work under /Users/yesh/.claude/skills/yesh-router/SKILL.md. Your step is one unit end to end, up to but not including the flip. Fast, simple, clean.

## Setup
1. `pnpm install --frozen-lockfile --prefer-offline` (pi-durable must be 1.4.0).
2. Git env: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false`.
3. Read AGENTS.md; docs/migration/effect/STATUS.md (Decisions, "the move is also a cleanup", "Waves 4–8"); .claude/skills/verify-ky-parity/SKILL.md; the Effect skills in .claude/skills (modeling-effect-domain, modeling-effect-errors, effect-do-storage, testing-effect-domains, decoding-effect-boundaries, deriving-schema-types).
4. Copy the shape of the shipped ports: src/approvals/**, src/skills/**, src/automations/**, src/core/{edge,sql}.ts, test/parity/{approvals,skills}/**. Patterns come from vendor/effect.

## The port
- The unit's flat files become `src/<domain>/` with contract.ts in Schema; a Context.Service + Layer over `Sql` only where something is provided; plain functions otherwise.
- Every stored table gets an Effect Schema row; rows written at B must decode. typebox goes, except where pi's tool parameters require it.
- Every throw a caller can hit becomes a tagged error mapped to a Refusal with B's exact words through `makeEdge`. Every `Date.now()` reads `Clock`. Untrusted input (HTTP bodies, wire messages, stored JSON) decodes with Schema at the boundary.
- The facade other code calls keeps its behaviour; callers keep getting `T | Refusal`. Update import lines in importers.
- protocol.ts: add at most one `export * from "./<domain>/contract"` line.
- Cleanup: no comments; dead code goes with the port; tests census marks MOCK, SCAN, SLEEP, COPY or UNIT, or that an invariant or parity already proves, are deleted through docs/migration/effect/prune-ledger.json (`pnpm ledger` must pass).

## You own
Your unit's files and `src/<domain>/**`; import lines in their importers; their tests in src/tests and test/invariants (new `test/invariants/<domain>.test.ts`); new `test/parity/<domain>/**` (legacy/ copy, at-b.json, at-b.test.ts, mutants/*.patch); prune-ledger.json entries for those tests. Your domain is already registered in test/parity/run.ts.

A unit with no stored state and no refusal (pure functions only) skips parity and at-b: say so in the report, and prove it with its existing tests plus the real surface.

## COS only, do not edit
package.json and the lockfile; src/core/edge.ts and sql.ts; the lint config and test/lint-ratchet.ts; gate-baseline.json; docs/migration/effect/** (except prune-ledger.json); vendor/effect; .claude/skills/**; test/{contracts,boundaries,features}.test.ts; test/parity/{kit,run}.ts and test/census.ts; src/server.ts and src/sockets.ts beyond import lines (a constructor change is a separate constructor-only commit I take or drop). Need anything else changed: stop and tell me what and why.

Other writers are porting the other units of your wave in parallel. Touch their files only at import lines.

## Rules
- No legacy code reaches main. No new lint or fallow baseline entries, no suppressions, no wrappers for old shapes.
- Never rename a test listed in gate-baseline.json unless the prune ledger removes it.
- Don't overengineer. No comments. No tests beyond what the proof needs.
- Typed errors; Schema at boundaries; TestClock in tests. No refusal through a defect (`Effect.try` into a tagged error, never `Effect.sync` over a throwing call). The oracle does not reuse the implementation's Schema. No boxing or `sure` helpers. No domain calls itself back through the edge.
- Each refusal rule, Clock read and stored column gets one property and one mutant.
- Commits carry no Co-Authored-By or agent attribution. Commit on your branch. Do not push, open a PR or deploy. Never run any wrangler write, `pnpm deploy` or `ky deploy`.

## Proof
1. Ratchet: every gate-baseline.json item for your files stays green (count them), or is removed through the prune ledger.
2. Parity: `.claude/skills/verify-ky-parity/scripts/prove.sh <domain> --runs 500 --seed 20261025`, 0 lost.
3. Mutants: every one caught.
4. Stored data: at-b.json recorded from a checkout of tag `effect-baseline` (b658a6e).
5. Real surface: the test/web/ky.spec.ts specs that reach your unit; `pnpm visual` 0 of 8.
Also `pnpm typecheck`, `pnpm lint` and the ratchet clean.

## Before you report (reviews keep finding these)
- `legacy/` is B byte for byte except import paths. Carry its lint findings to the new path; they leave at the flip.
- No test that survives the flip imports `legacy/` or a file that does. Parity lives under test/parity/<domain>/; invariants import only world and generators.
- Every table has one row Schema, and every select picks from it. Rows B tolerated when damaged are skipped or read as absent, never `orDie`.
- Everything parity alone proves gets a property before the flip, so the flip loses nothing. One mutant per refusal rule, Clock read, stored column, ordering and cap.
- src/tests now proven by invariants go through the prune ledger.
- No re-exports for convenience, no import cycles, no `Schema.mutable` without a caller that mutates, no `makeEdge` at module scope.
- Fix rounds run prove.sh with `--runs 100`; the 500-run proof runs once, at the flip.

## Report
Finish in one pass: fix, rebase on effect/next-wave, flip, prove at 500, then report once. Reply with: branch and commit; the prove.sh summary (runs, lost, mutants caught of total); gate items and prune-ledger entries; server.ts or sockets.ts commits for the COS; anything you could not do. Access, mail and push get a Fable review before the flip; stop for it there.
