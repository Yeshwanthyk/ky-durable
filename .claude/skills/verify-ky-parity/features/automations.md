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

Not provable yet: verified-unreachable until U2.

- **Parity (check 2):** needs `src/automations/legacy/` and a `contract.ts` the kit can drive, with
  clock advances for the Scheduler. U2 builds them, and first extends the kit (Fable's U0 review):
  one clock the kit owns and both sides read, not an `advance` per side, so a fake-timer clock can't
  move the port along with legacy; a `pending()` view (next alarm, what's due) compared after each
  step; and an advance that jumps to the next alarm, since hourly slots never fire in 30 steps of
  seconds.
- **Invariants (check 3):** the three quint invariants above as a fast-check property, with mutants
  (a second spawn per slot, a post after pause). U2 builds them.
- **Stored data (check 4):** rows seeded at B in each `AUTOMATION_TABLES` table, loaded by the port.

## Gotchas

- **B fails 7 of its own invariant tests** in `test/invariants/automations.test.ts` › stored rows:
  `automationRows` reads the model column as undefined, and the corrupt-model cases fail with it. The
  gate holds them as red at B; the owner decided U2 fixes them.
- `boundaries.test.ts` is red at B too: `src/ui/Automations.tsx` imports automations' `zoned`
  outside its contract.
- Real timers in `src/tests/automations.test.ts` (census SLEEP signal) make it slow; the port moves
  them to TestClock.
