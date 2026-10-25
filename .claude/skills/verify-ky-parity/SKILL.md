---
name: verify-ky-parity
description: Prove a domain of ky ported to Effect v4 still does what it did at baseline B (effect-baseline, b658a6e). Runs the five checks (ratchet against B's tests, parity of legacy and new behind one contract, the domain's invariants, stored data from B, the real surface) and the mutant runs that show the proof can fail. Use while porting or before merging any domain under docs/migration/effect, and after touching test/parity/, test/invariants/, test/gate.ts, test/ledger.ts or gate-baseline.json.
---

# Verify a ky domain against B

A port is done when it does what B did, except where it fixes a B bug on purpose, and every check
below says so at the bar: **500 runs of up to 30 steps**. Everything runs locally, against fakes and
the local stack. Nothing here deploys: AGENTS.md "Deploying" holds, and deploy is proven only
against `test/fakes/cloudflare.ts`.

## Launch

Checks 1 to 4 need no running process: they are vitest runs. Check 5 needs the local stack, launched
by the recipes it borrows (verify-ky-cli, verify-ky-web, verify-ky-machines). The full gate
(`pnpm gate`) starts its own.

## Doctor (read-only)

```sh
.claude/skills/verify-ky-parity/scripts/doctor.sh <domain>
```

Checks node 22+, dependencies, the `effect-baseline` tag on b658a6e, the effect pin, the prune
ledger, that `gate-baseline.json` items carry their files, that `src/` and `cli/` are clean (a mutant
run patches them), and that no `CLOUDFLARE_API_TOKEN` is set. Every line must read `ok`.

## Drive

Checks 1 to 3 in one go, stopping at the first red:

```sh
.claude/skills/verify-ky-parity/scripts/prove.sh <domain>            # 500 runs, a fresh seed
.claude/skills/verify-ky-parity/scripts/prove.sh <domain> --seed S   # replay a counterexample
```

The five checks, and what runs each:

1. **Ratchet.** Every test in the domain's files that passed at B still passes, or the prune ledger
   (`docs/migration/effect/prune-ledger.json`) deleted it with a reason and what replaced it.
   `scripts/ratchet.ts <domain>`; the whole repo's version is `pnpm gate`, which runs every check
   and judges tests only by `gate-baseline.json`, since B fails some of its own.
2. **Parity.** While a domain is ported, B's code (`<domain>/legacy/`, deleted at the flip before
   merge: nothing legacy reaches main) and the port sit behind
   one `contract.ts`; `test/parity/kit.ts` drives both with the same generated actions and clock
   advances and compares results, refusals, tables and effects after each step. A bug fixed on
   purpose is a `Divergence`, listed in `docs/migration/effect/divergences/<domain>.md` with the
   invariant test that holds it. `pnpm parity <domain>`.
3. **Invariants.** Oracles that don't read the implementation, in `test/invariants/<domain>.test.ts`.
   `pnpm parity <domain>` runs them at the bar, and `--mutant all` applies each
   `test/parity/<domain>/mutants/*.patch` and must go red, or the proof can't see that break.
4. **Stored data.** A database written at B loads under the port, and `ky_restore__<table>` names
   don't change. Per domain; see its feature file. On real data, once per area before merge, from a
   backup the owner has okayed (`pnpm ky backup` is a read-only GET; never restore into a live ky):

   ```sh
   node --experimental-strip-types --no-warnings .claude/skills/verify-ky-parity/scripts/real-data.ts ~/ky-backups/<ky>-<time>.tar.gz
   ```

   It restores the backup into a fresh local stack at B and on this checkout, backs each up again,
   and fails when HEAD loses other rows than B does or a page shows other counts. At B every restore
   empties `workspace_runtime_events` and `workspace_runtime_executions` (the sandbox runtime starts
   fresh), so both sides list them. Look at the screenshots too.
5. **Real surface.** The domain's recipes in verify-ky-cli, verify-ky-web and verify-ky-machines,
   on the local stack, and `test/visual/` screenshots of its pages at B and on the branch.

What to keep and prune comes from `pnpm census <domain>`: INVARIANT and E2E files stay; MOCK, SCAN,
SLEEP, COPY and UNIT tests may go, each with a ledger entry.

## Evidence

- `test-results/parity/<domain>/ratchet.json`: files, tests held at B, lost, red at B already.
- `test-results/parity/<domain>/proof.json`: runs, steps, seed, tool versions (node, vitest,
  fast-check, effect, commit), and the first counterexample on failure.
- `test-results/parity/<domain>/mutant-<name>.json`: `holds: true` when the mutant was caught.
- `test-results/parity/real-data/{base,head}/`: `report.json` and a screenshot per page. They hold
  the owner's chats; `test-results/` is ignored by git, and they never leave this machine.
- `test-results/census/<domain>.json`; `test-results/gate/*.log` for a full gate.

Report the seed with every result. A red run is replayed with `--seed`.

## Cleanup

`pnpm parity --mutant` restores the files it patched however the run ends; `git status` must be
clean afterwards. Stacks from check 5 are torn down per their recipes. Keep `test-results/`.

## Features

The map is [features/README.md](features/README.md): one file per domain, with what each check
covers there today and what the port still has to build.
