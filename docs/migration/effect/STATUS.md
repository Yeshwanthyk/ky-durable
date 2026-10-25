# ky → Effect v4: status

The checkpoint for the migration. One writer: the chief-of-staff thread on `effect/foundation`. Each
later wave starts only on the owner's plain "go".

**Baseline B** = `origin/main` b658a6e, tagged locally `effect-baseline`. Every domain is measured
against B, never against the PR before it.

## Units

| Unit | What | Owner (thread) | Branch / worktree | State | Evidence |
| --- | --- | --- | --- | --- | --- |
| U0 | Foundation: pin, baselines, `core/edge.ts`, parity kit, census, ledger, screenshot diff, `verify-ky-parity`, Effect skills | chief of staff (this thread) | `effect/foundation` | in progress | below |
| S1 | DO storage spike: `@effect/sql-sqlite-do` in PiAgent (hibernation, alarms, bundle, cold start) | `mcp:ae07114b-dc22-45b7-9443-4f482c0320c9` (settled) | `spike/effect-do-storage` (throwaway, never merges) | done: wrap raw `ctx.storage.sql` | `docs/spike/effect-do-storage.md` on its branch |
| U1 | Deploy (pilot) | — | — | waits for Wave 1 "go" | — |
| H1 | Harvest after U1 | — | — | waits for Wave 1 "go" | — |
| U2 | Automations | — | — | waits for Wave 2 "go" | — |
| U3 | Skills | — | — | waits for Wave 2 "go" | — |

## U0 steps

| Step | State | Evidence |
| --- | --- | --- |
| Tag B | done | `git rev-parse effect-baseline` = b658a6e |
| effect 4.0.6, @effect/vitest 4.0.6 | done | `package.json`; `pnpm -s effect:pin` |
| `vendor/effect` at effect@4.0.6 (3b28bf6) + pin check in `pnpm check` | done | `test/effect-pin.ts`; red on a range, a split version, a vendor version |
| Fallow baselines re-saved at B | done | `fallow/dead-code.json`, `fallow/health.json` |
| `gate-baseline.json` re-recorded at B | in progress | `test-results/gate/` in the B checkout |
| Gate runs `invariants`, judged by the baseline only (B fails 9 of them) | done | `test/gate.ts` `ratchetOnly` |
| Prune ledger + check in `pnpm check` and the gate | done | `test/ledger.ts`, `docs/migration/effect/prune-ledger.json` |
| Cloudflare fake can cut power after request k | done | `test/fakes/cloudflare.ts` `cut`, `served` |
| Deploy invariants I-D1..I-D5 | done: 500 runs of up to 30 steps, seed 1940260227 | `test-results/parity/deploy/proof.json` |
| Deploy mutants (4) | done: all four caught by `pnpm parity deploy --mutant all` | `test-results/parity/deploy/mutant-*.json` |
| Parity kit + toy self-test + `pnpm parity` runner | done; toy mutant caught (add, then cancel) | `test/parity/kit.ts`, `test/parity/toy/`, `test/parity/run.ts` |

## Decisions

- **@distilled.cloud 1.0.0-rc.12 → rc.13.** rc.12 imports `effect/unstable/http/*`, which effect 4.0
  moved to `effect/http/*`, so the effect bump forces a distilled bump. rc.13 (peer `effect ^4.0.0`)
  typechecks with no deployer change; rc.15 and rc.17 change the container-application types and
  would edit `cli/deployer.ts`, which is U1's. One import moved in `cli/cloudflare.ts`
  (`effect/unstable/http/FetchHttpClient` → `effect/http/FetchHttpClient`).
- **Fallow baselines re-saved at B.** B fails its own `pnpm gate` at fallow: #176 left 6 unused
  exports, 1 unused class member and 2 duplicate export names (dead-code), and 77 complexity
  findings over `fallow/health.json`. Some are false positives (`Models.choices` is called; fallow
  skips `.claude/` and marks its graph incomplete). B's findings are now the baseline; fixing them is
  product work for the owning domain, not foundation's.
- **`pnpm fallow` uses the dead-code baseline**, as the gate already did; without it `pnpm check`
  fails at B.

## Found at B

- **I-D3, deploy:** a crash between `POST r2/buckets` and the `.ky` marker's PUT leaves a bucket
  `claim()` refuses forever ("ky didn't create it"); the owner's ky can't deploy until the bucket is
  deleted by hand.
- **I-D2, deploy:** a repeat deploy re-PUTs both Access apps, opens an assets upload session,
  re-uploads the Worker (a new version each time) and re-POSTs the subdomain.
- Both are pinned as exact `B_BREACHES` in `test/invariants/deploy.test.ts`: the test fails if either
  goes away unnoticed or a new breach appears. U1 fixes them and moves them to
  `divergences/deploy.md`.
- **B fails 9 of its own `pnpm test:invariants`:** 7 in `automations.test.ts` › stored rows (model
  column reads undefined), 1 in `boundaries.test.ts` (`src/ui/Automations.tsx` imports automations'
  `zoned`), 1 in `contracts.test.ts` › storage (corrupt JSON decodes to undefined, not null). The
  gate never ran invariants, so it went unseen. `pnpm check` is red at B for this.

## Known flakes at B

- `worker-e2e` · `src/tests/chats-tool.test.ts` › "steers a working chat into the turn it is in…":
  `inspect` sometimes reads the chat's auto-title ("Named: gate") instead of its name. 1 failure in 5
  isolated runs at B (`pnpm -s test src/tests/chats-tool.test.ts -t "steers a working chat"`), and it
  failed the first full gate run at B. Product race in chat titles, not a migration regression.

- **Owner, 2026-10-25:** B's deploy bugs are fixed in U1, as divergences, not on main first.
- **Owner, 2026-10-25:** B's 9 red invariants are fixed by each owning domain's port; until then the
  gate holds them as failing at B.
- **Owner, 2026-10-25:** DO storage wraps raw `ctx.storage.sql` in a sync-first Effect service
  (`Effect.try`, tagged `SqlError`, `transactionSync`, Schema rows); `@effect/sql-sqlite-do` waits
  until a domain has no sync callers (S1).
- **`lint-baseline.json` gained `test/invariants/deploy.test.ts`'s 6 unsafe-* findings:** wrangler's
  `experimental_readRawConfig` is error-typed to oxlint, as in `cli/compile.ts` already.

## Environment notes

- The worktree hook did not clone `node_modules`; it was APFS-cloned from the main checkout and synced
  with `pnpm install --frozen-lockfile --prefer-offline`.
- Docker isn't installed on this Mac; no shared infra to reuse.
