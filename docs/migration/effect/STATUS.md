# ky → Effect v4: status

The checkpoint for the migration. One writer: the chief-of-staff thread, on a branch cut from `main`
(`effect/next-wave` from 0af806a; `effect/foundation` is retired, its history squashed into main). Each
later wave starts only on the owner's plain "go".

## Shipped (2026-10-26)

Waves 1 and 2 (deploy, automations, skills) are squash-merged to main as 0af806a (#177). deploy.yml
deployed it to squarey; `ky doctor squarey` reports all good: Release 0af806a, migrations v3, cloud machine
on the newest release's image. Still on B's code: dreaming, peers, machines, approvals, inbound, and the
flat `src/*.ts` modules. Next: discovery of Wave 3 (a read-only scout per candidate), then the owner picks.

**Baseline B** = `origin/main` b658a6e, tagged locally `effect-baseline`. Every domain is measured
against B, never against the PR before it.

## Units

| Unit | What | Owner (thread) | Branch / worktree | State | Evidence |
| --- | --- | --- | --- | --- | --- |
| U0 | Foundation: pin, baselines, `core/edge.ts`, parity kit, census, ledger, screenshot diff, `verify-ky-parity`, Effect skills | chief of staff (this thread) | `effect/foundation` | done; end-of-wave recap sent | below |
| S1 | DO storage spike: `@effect/sql-sqlite-do` in PiAgent (hibernation, alarms, bundle, cold start) | `mcp:ae07114b-dc22-45b7-9443-4f482c0320c9` (settled) | `spike/effect-do-storage` (throwaway, never merges) | done: wrap raw `ctx.storage.sql` | `docs/spike/effect-do-storage.md` on its branch |
| U0-A | Screenshot diff script (`test/visual/**`) | `mcp:b4638a39-81a8-48f9-97f7-7385a7a84a2f` (settled) | `effect/lane-screenshot-diff` | done, integrated (2bacb35, 4136158, 65d0921) | `pnpm visual`: B vs HEAD 0 on 8 pages |
| U0-B | Effect skill drafts (`drafts/effect-skills/**`; chief of staff moves them into `.claude/skills`) | `mcp:50c88100-ebe8-4eb1-afad-0ba94b28c4b6` | `effect/lane-skill-drafts` | done, settled (9c066ba) | its thread |
| U1 | Deploy (pilot) | `mcp:8758b1bd-ad05-4614-a90c-5aabb146c3af` | `effect/u1-deploy` (from `effect/foundation`) | done, merged into foundation (dbb56e4): ported (f1ebace), parity (c0f5b65), mutants + I-D6/I-D7 (52e1bc6), flip deleted `cli/deploy/legacy/` (942c147); refusals `implements Refusable`, boundaries fence on `cli/deploy` (e51c888); divergences I-D2/I-D3 fixed (b7a9692); Fable 5.1 review: FIX FIRST, finding 1 fixed (b1a8aa1), the rest recorded |  `prove.sh deploy --seed 20261025`: 69 held, 0 lost; 500 runs; 6/6 mutants; statechart shown to owner |
| W1-K | Kit: one clock per run, `due`/`pending`/`nextAlarm` | chief of staff | `effect/foundation` | done (3c162ba) | toy 7/7; `--mutant all` caught at 500 runs |
| W1-S | `src/core/sql.ts`: sync-first `Sql` service over `ctx.storage.sql` | chief of staff | `effect/foundation` | done (4e8d6b5, 70ce4f8) | 5/5 on a real DO; no-rollback mutant red |
| W1-R | Real data: squarey's backup restored at B and on the branch | chief of staff | `effect/foundation` | done for foundation | `real-data.ts`: HEAD = B (47 skills, 16 routines; same 2 runtime tables emptied on both) |
| H1 | Harvest after U1 | chief of staff | `effect/foundation` | done: `scripts/mutant.sh` (open, then save) regenerates a moved mutant (round-tripped unmarked-bucket, still caught); doctor fails on stale `node_modules`; the skill's scripts turn off fsmonitor (the IPC noise); SKILL.md says read exit codes, not piped output. Temp-path normalization already lives in the deploy proof | `doctor.sh deploy` all ok |
| U2 | Automations | `mcp:a60c26c0-d744-4bc6-b9e3-62c6f5a27b69` | `effect/u2-automations` (from foundation 4d79519) | done, merged into foundation (d18db43, 8720ce5): ported (3b3c9b1), quint invariants as properties + 4 mutants (201a36a, aa6166e), rows at B (926bbe2), flip (200e4f9), model column decoded in Schema (3a8bb77); B's 9 red invariants pass and left gate-baseline (4aaac8c); Fable 5.1 review: 8 findings, 5 and 6 recorded, 2 owner-decided, 7 fixed in the edge (6046862), 1, 3, 4, 8 go to U2b | on foundation: `prove.sh automations --runs 500 --seed 20261025`: 159 held, 0 lost; 500 runs; 4/4 mutants; `pnpm check` 0 (223); real-data HEAD = B; web 10, harness 2, visual 0/8 (U2's) |
| U2b | Automations: Fable fixes 1 (no self-call through the edge), 3 (OneRunPerSlot's posted half), 4 (a zone-less row is UTC, as B's column), 7 (drop `sure`), 8 | `mcp:a60c26c0-d744-4bc6-b9e3-62c6f5a27b69` | `effect/u2b-automations` (from foundation cac82db) | done, merged into foundation (a2792cc, feac925); OneRunPerSlot note and Zone divergence row updated with it | on foundation: `prove.sh automations --runs 500 --seed 20261025` PASS, 4/4 mutants; `pnpm check` 0 (224) |
| U3 | Skills: library and review log | `mcp:668d9e4a-78b7-4945-b25e-cbf5d8e98a21` | `effect/u3-skills` (from foundation 4d79519) | done, merged into foundation (a63fb56); flip deleted `src/skills/legacy`; Fable 5.1 review: 5 findings, 2 and 5 recorded in `divergences/skills.md` (4b6b3a4), 1, 3, 4 go to U3b | on foundation: `prove.sh skills --runs 500 --seed 20261025`: 112 held, 0 lost; 500 runs; 5/5 mutants; real-data HEAD = B; visual 0 of 8 |
| U3b | Skills: Fable fixes 1, 3, 4 (stale-sweep property sees `last_used_at`, an independent answers oracle, one storage helper); port `specialists.ts` and `subagents.ts` with their exported API unchanged | `mcp:668d9e4a-78b7-4945-b25e-cbf5d8e98a21` | `effect/u3b-skills` (from foundation) | merged into foundation (3a56ffa, a54b924): fixes 1, 3, 4; specialists ported (Roster over Sql, facade API unchanged, server.ts passes storage); subagents keep no DO storage; 1 divergence (corrupt specialist wording); Fable 5.1 review: 6 findings, nothing serious; 2, 5, 6 recorded, 1, 3, 4 go to U3c | on foundation: `prove.sh skills --runs 500 --seed 20261025`: 112 held, 0 lost; 9/9 mutants; automations still 159 held, 4/4; `pnpm check` 0 (227); U3b: web 7, harness skills and skill-review; real-data on squarey at 3a56ffa: HEAD = B (47 skills, 16 routines; only the 2 runtime tables lost on both) |
| U3c | Skills: Fable specialists fixes 1 (an empty brief is a typed refusal), 3 (descriptionOf refusals and a mutant), 4 (created_at from Clock asserted, a mutant) | `mcp:668d9e4a-78b7-4945-b25e-cbf5d8e98a21` | `effect/u3c-skills` (from foundation 2964e88) | done, merged into foundation (f98761a, ad0382e): BriefRefused in create's E; refusal and Clock-time properties; 3 mutants | on foundation: `prove.sh skills --runs 500 --seed 20261025`: 112 held, 0 lost; 12/12 mutants; `pnpm check` 0 (230) |
| W2-K | Kit: a mutant run no longer overwrites `proof.json`; `fc.commands` size large (U3's note) | chief of staff | `effect/foundation` | done (77132f0) | `prove.sh deploy --runs 500 --seed 20261025`: 69 held; 500 runs; 6/6 mutants, evidence kept |

## Resumed (2026-10-25)

Owner: Wave 2 go, U2 and U3 in parallel; the four stale worktrees removed (branches kept). Next: each unit reports, then real-data restore, Fable 5.1 review, merge.

## Paused here (2026-10-25, superseded)

- **Objective:** move ky to Effect v4, domain by domain, each proven against B; Wave 1 (deploy) is closed.
- **State:** foundation clean at b1a8aa1 plus this note; nothing pushed; no thread or agent running.
- **Proof:** `prove.sh deploy --seed 20261025` after the review fix: ratchet 69 held, 0 lost; 500 runs; 6/6 mutants.
  `pnpm typecheck`, `lint` (425, baseline), `fallow` pass.
- **Fable review of deploy, findings:** 1 fixed (a containers check that can't reach Cloudflare fails the
  deploy instead of dropping the cloud machine; untested: the fake can't drop a request). 2 and 4 recorded
  as residual risks in `divergences/deploy.md`; 5 recorded there. Not done, on purpose (owner: don't
  overfix): 3 (refusals travel as defects through `Cloudflare.run`), 6 (`bucketState` read twice),
  7 (Service with no dependencies, `Out<T>`, unused Schemas). Pick up only if a later domain needs them.
- **Next action:** recap to the owner and ask for the Wave 2 go (U2 automations, U3 skills, each a writer
  in its own worktree from foundation; big delegation, so show the review first).
- **Owner's call:** stale worktrees effect-lane-screenshot-diff, effect-lane-skill-drafts,
  spike-effect-do-storage, effect-u1-deploy (merged).

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

- **Owner, 2026-10-26:** Wave 3 is the dreaming core (Versioned, Soul, ledger, and the two couplings in skills)
  and approvals then inbound, two writers in parallel. Peers and the rest of dreaming wait for Wave 4; machines
  (slim plan shipped, #94 to #111) and the flat modules later. Discovery: six Haiku scouts, one per candidate.

- **Owner, 2026-10-25:** Effect may ship to the browser: the UI enters a domain through its contract, even when that pulls in Effect Schema (about 70 KB gzip for automations' contract alone, Fable's measure).

- **Owner, 2026-10-25:** Wave 2 go as drawn: U2 automations and U3 skills in parallel, Opus 5.5 writers in their own worktrees, a Fable 5.1 review each; `contracts.test.ts`, `boundaries.test.ts`, `features.test.ts` and `kit.ts` stay the chief of staff's.

- **Owner, 2026-10-25:** no legacy code reaches main. `legacy/` is scaffolding on an area's branch for the parity run;
  the flip deletes it, the code it replaced and the prunable tests, then reproves on the port alone. Code stays tight:
  no new lint or fallow baseline entries, no suppressions, no wrappers kept for old shapes.
- **Owner, 2026-10-25:** squarey must come up as usual. Its backup (`ky backup`, read-only, kept in `~/ky-backups/`,
  never in git) is restored into local stacks at B and on each branch (`verify-ky-parity/scripts/real-data.ts`);
  nothing is ever restored into a live ky.
- **Owner, 2026-10-25:** Wave 1 runs as a DAG: U1 in its thread, kit clock, `Sql` and the real-data check here in parallel.

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
