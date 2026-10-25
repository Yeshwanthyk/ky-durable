# ky → Effect v4: status

The checkpoint for the migration. One writer: the chief-of-staff thread on `effect/foundation`. Each
later wave starts only on the owner's plain "go".

**Baseline B** = `origin/main` b658a6e, tagged locally `effect-baseline`. Every domain is measured
against B, never against the PR before it.

## Units

| Unit | What | Owner (thread) | Branch / worktree | State | Evidence |
| --- | --- | --- | --- | --- | --- |
| U0 | Foundation: pin, baselines, `core/edge.ts`, parity kit, census, ledger, screenshot diff, `verify-ky-parity`, Effect skills | chief of staff (this thread) | `effect/foundation` | done; end-of-wave recap sent | below |
| S1 | DO storage spike: `@effect/sql-sqlite-do` in PiAgent (hibernation, alarms, bundle, cold start) | `mcp:ae07114b-dc22-45b7-9443-4f482c0320c9` (settled) | `spike/effect-do-storage` (throwaway, never merges) | done: wrap raw `ctx.storage.sql` | `docs/spike/effect-do-storage.md` on its branch |
| U0-A | Screenshot diff script (`test/visual/**`) | `mcp:b4638a39-81a8-48f9-97f7-7385a7a84a2f` (settled) | `effect/lane-screenshot-diff` | done, integrated (2bacb35, 4136158, 65d0921) | `pnpm visual`: B vs HEAD 0 on 8 pages |
| U0-B | Effect skill drafts (`drafts/effect-skills/**`; chief of staff moves them into `.claude/skills`) | `mcp:50c88100-ebe8-4eb1-afad-0ba94b28c4b6` | `effect/lane-skill-drafts` | done, settled (9c066ba) | its thread |
| U1 | Deploy (pilot) | launching | `effect/u1-deploy` (from `effect/foundation`) | Wave 1 go 2026-10-25 | — |
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
| `gate-baseline.json` re-recorded at B | done: 1170 items with files; red at B: 9 invariants, 1 web (the Send locator flake) | `gate-baseline.json` |
| Gate runs `invariants`, judged by the baseline only (B fails 9 of them) | done | `test/gate.ts` `ratchetOnly` |
| Prune ledger + check in `pnpm check` and the gate | done | `test/ledger.ts`, `docs/migration/effect/prune-ledger.json` |
| Cloudflare fake can cut power after request k | done | `test/fakes/cloudflare.ts` `cut`, `served` |
| Deploy invariants I-D1..I-D5 | done: 500 runs of up to 30 steps, seed 1940260227 | `test-results/parity/deploy/proof.json` |
| Deploy mutants (4) | done: all four caught by `pnpm parity deploy --mutant all` | `test-results/parity/deploy/mutant-*.json` |
| Parity kit + toy self-test + `pnpm parity` runner | done; toy mutant caught (add, then cancel) | `test/parity/kit.ts`, `test/parity/toy/`, `test/parity/run.ts` |
| `pnpm census <domain>` (keep: INVARIANT, E2E; prune: MOCK, SCAN, SLEEP, COPY, UNIT) | done | `test/census.ts`; `test-results/census/*.json` |
| `verify-ky-parity` skill: doctor, ratchet, prove, one feature file per domain | done: `prove.sh deploy` passes end to end in 1m37s (ratchet 69 held, 0 lost; 500 runs, seed 1941735122; 4/4 mutants); the ratchet goes red on a skipped B test and on a new red test | `.claude/skills/verify-ky-parity/`; `test-results/parity/deploy/` |
| `divergences/deploy.md` | done: I-D2, I-D3 open for U1 | `docs/migration/effect/divergences/deploy.md` |
| Fable 5.1 review of U0, round 1 (foundation) | done: 7 findings; 1, 2, 3, 5 (weighting), 6, 7 (one `regressions`) fixed; 4 (one clock, `pending()`) goes to U2; 5's `fc.pre` kept (a cut in a known-broken window poisons the run, so it must be discarded); `vendor/effect` kept (owner asked for it) | `test/ledger.ts` `regressions`; `test/parity/run.ts`; `test/parity/kit.ts`; `src/core/edge.ts`; deploy `--mutant all` at 100 runs: 4/4 caught by tests that held clean |
| Lane B skill drafts | done: six skills moved into `.claude/skills/` with the foundation's rules (092c738) | `.claude/skills/{modeling-effect-errors,decoding-effect-boundaries,deriving-schema-types,modeling-effect-domain,effect-do-storage,testing-effect-domains}` |
| Screenshot diff integrated | done: `pnpm visual` / `visual:capture` / `visual:diff`; threshold 0.0001; B vs HEAD 0 on 8 pages from foundation; `pnpm check` red only on B's 9 | `test/visual/`; `fallow/health.json` |

## Decisions

- **Owner, 2026-10-25:** reviews stay Fable 5.1 only for the whole migration (no Astra on this machine). Wave 1 approved as drawn: U1 writer + chief of staff builds the kit clock and DO storage service alongside.

- **Owner, 2026-10-25:** U0 splits into lanes A (screenshot diff) and B (skill drafts) as T3 threads;
  U0's review is Fable 5.1 alone (GPT-6 Astra isn't available).

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

- `web` · `ky.spec.ts:2112` "refuses an image the stand-in model can't read…": `getByRole("button",
  { name: "Send" })` also matches a chat an earlier test auto-titled "…gmail.send…", so the locator
  resolves to 4 elements. Failed the first B record. A test bug at B (needs `exact: true`).
- **Gate change:** every check that reports tests (node, worker-e2e, harness, web, invariants) is
  judged by the baseline only, not its exit code; a check that writes no fresh report still fails.
  B's gate couldn't record otherwise: its own flakes stopped it 2 of 3 tries.

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
