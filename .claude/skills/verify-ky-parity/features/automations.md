# Automations

A routine runs on its schedule, once per slot, never two at once, and nothing starts or posts after
it's paused.

## Behaviors

From `explainers/ky-architecture/quint/automations.qnt`:

- **OneRunPerSlot** each scheduled slot spawns at most one run and posts at most one report.
- **NoOverlap** at most one run of a routine is live.
- **NothingAfterPause** nothing starts or posts once the routine is off.

And for the port: the tables in `AUTOMATION_TABLES` (`src/automations/contract.ts`) keep their names,
and rows written at B decode under the port.

## User entry points

The Routines page (web), the chat tool's automation actions, the runner protocol when a machine runs
a routine, and the Scheduler's alarm.

## Drive

```sh
.claude/skills/verify-ky-parity/scripts/prove.sh automations
```

- Ratchet files (`pnpm census automations`): `src/tests/{automation-order,automations,features,runner-protocol,zoned}.test.ts`,
  `test/invariants/{automations,contracts,delivery,push}.test.ts`.
- Real surface: verify-ky-cli's automations recipe and verify-ky-web's Routines page; the harness
  scenarios `automation-run` and `automation-machine`.

## Proof

Provable: `prove.sh automations` passes on the port alone (U2, legacy flipped out).

- **Parity (check 2):** ran B against the port, with one clock the kit owns and the Scheduler as a
  fake, until the flip; that run's evidence is `test-results/parity/automations-preflip/`. There is
  no parity side now.
- **Invariants (check 3):** the quint invariants (no overlap, one run per slot, nothing after pause)
  as properties in `test/invariants/automations.test.ts`, over `test/parity/automations/world.ts`;
  four mutants in `test/parity/automations/mutants/`, each caught. Every runs property starts with a
  fixed run (done, paused, reported), or post-after-pause slips past.
- **Stored data (check 4):** `test/parity/automations/at-b.test.ts` opens B's tables, bookings and
  reads (`at-b.json`, recorded from B) under the port; on real data, `real-data.ts`.

## Gotchas

- B's 7 red stored-rows tests, `boundaries.test.ts` and `contracts.test.ts` › storage pass on the
  port; they left `gate-baseline.json`, so going red again fails the gate as new since B.
- Fallow reads no types: a member reached only through a destructured Host service looks dead.
  Name the service's type at the binding (`const feed: TaskFeed = host.feed`), not an exemption.
- Real timers in `src/tests/automations.test.ts` (census SLEEP signal) make it slow.
