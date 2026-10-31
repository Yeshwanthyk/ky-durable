# A model of specialist profiles

`Specialists.tla` is the fixed design of what each owner (ky, or a specialist) may use: its home sandbox, the Macs the user granted it, its browser session and Vault logins, and the workflows it owns. `specialists_check.py` explores the same state machine exhaustively, with each fix behind a flag, and prints the shortest trace for every invariant a configuration breaks.

The world is small on purpose: ky and two specialists (`fin` holds a bank login, `res` reads the web), one paired Mac, one site, one workflow, and delegations res → ky, res → fin, ky → fin.

## What it checks

| Invariant | Rule | Says |
|---|---|---|
| RunnerScope (I1) | R1 | Work runs only on its owner's sandbox or a Mac it was granted; revoking the Mac stops the owner's run on it. |
| SessionMatchesVault (I2), NoStaleCookies (I3) | R2 | A live browser session holds only logins its owner has in the Vault. |
| DeadSpecialistIdle (I7), NoOrphanWorkflow (I8) | R3 | A deleted specialist has no runs or calls; its workflow goes to ky. |
| NoSilentFallback (I5) | R4 | A workflow whose Mac is offline doesn't run somewhere else. |
| OneProfilePerRun (I6) | R5 | A run keeps the owner it started with, though the workflow is reassigned. |
| (machine_tool_checks) | R6 | The machine tool checks the profile, not the prompt. |
| NoLaundering (I4) | R7 | A bank write that web text led to, directly or through a delegation, waits for the user. |

NoSilentFallback and OneProfilePerRun hold by construction in the TLA+ (StartRun picks only allowed machines that are up; a run's owner is fixed at start); the Python checker models their naive forms too.

`test/invariants/specialist-profiles.test.ts` holds the same seven rules as property tests over ky's code, as each phase lands.

## Running it

The Python checker needs nothing but Python 3:

```
python3 -I specialists_check.py            # every fix off, then every fix on
python3 -I specialists_check.py --ablate   # each fix off alone
```

TLC, with Java 11 or later and [tla2tools.jar](https://github.com/tlaplus/tlaplus/releases):

```
java -cp tla2tools.jar tlc2.TLC -config Specialists.cfg Specialists
```

## Results

Every fix off: 153,600 states, every invariant broken. Every fix on: 16,668 states, none broken. Each fix off alone:

| Fix off | Breaks | Shortest trace with every fix off |
|---|---|---|
| revoke_stops_runs | RunnerScope | Grant(fin,mac) → StartRun(fin@mac) → Revoke(fin,mac) |
| move_ends_sessions | SessionMatchesVault, NoStaleCookies | HandoffLogin(fin) → MoveLogin(fin->ky) → BankWrite(fin) |
| delete_cleans | DeadSpecialistActs, OrphanWorkflow | DeleteSpecialist(fin) → StartRun(fin@sb_fin) |
| no_silent_fallback | NoSilentFallback | Grant(fin,mac) → MacToggle → StartRunFallback(fin) |
| profile_snapshot | RunnerScope, OneProfilePerRun | StartRun(fin@sb_fin) → ReassignWorkflow(ky) → RunStep(ky@sb_fin) |
| tainted_writes_ask | NoLaundering | HandoffLogin(res) → ReadWeb(res) → BankWrite(res) |
| machine_tool_checks | RunnerScope | MachineCall(ky->mac) |
| taint_propagates | nothing alone | |
| delegation_carries_taint | nothing alone | |

The two taint fixes cover each other: with both off, NoLaundering breaks by HandoffLogin(fin) → ReadWeb(res) → Delegate(res->fin) → BankWriteFor(res->fin). ky keeps both: the conversation's mark, and the mark a delegation message carries.
