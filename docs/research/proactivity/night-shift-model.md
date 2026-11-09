# Night shift: the model

What must stay true as ky moves from three fixed looks to waking on its own. Code: `src/dreaming/pace.ts`
(the pure rules), `src/dreaming/looks.ts` (runs them), `src/dreaming/events.ts`, `src/dreaming/map.ts`.

## Authoritative state

| State | Owner | Table |
| --- | --- | --- |
| Proactivity on/off, look times, pace (quiet / balanced / eager) | `Proactivity` | `ky_proactivity` |
| Events waiting for a look, and the look that took each | `LookEvents` | `ky_look_events` |
| What the last look read (its fingerprint) and every look that asked the model | `Looking` | `ky_look_runs` |
| The work map: what the user is working toward, its state and next step | `WorkMap` | `ky_map` |
| What ky started on its own, and the user's verdict on it | `Looking` via `parts.start` | `ky_starts` |
| The one look ky booked for itself, and why | `LookEvents` (`book`) and the scheduler (`nextLookAt`) | `ky_look_next` |

Derived: heartbeat times (from look times and pace), "changed since the last look" (from the fingerprint),
the day's budget (from the pace and the last week's reactions: 👍 and kept starts, less 👎 and discarded) and what is left of it (from `ky_look_runs`). Delivery stays `Delivery` (`ky_deliveries`), keyed by id.

## Transitions

| Trigger | Actor | Precondition | Write |
| --- | --- | --- | --- |
| A mail is triaged | `#triageMail` | Proactivity on | `ky_look_events` insert-or-ignore by `mail:<id>`; book an event look in 5 min when pace is not quiet and it is inside the waking window |
| A look time fires | scheduler `look` | on, cap allows `look`, no look running | claim pending events; ask the model; post; record the run |
| A heartbeat fires | scheduler `look` | as above, plus pace not quiet, budget left, and something changed or an event waits | as above |
| An event look fires | scheduler `look` (time `event`) | as above, plus an event waits | as above |
| A booked look fires | scheduler `look` (time `next`) | as a look time, plus budget left | as above |
| Any look ends | `Looks.bookNext` | its `next` row, or a due date within reach; awake and not quiet | `ky_look_next` replaced or cleared; the one `next` alarm cancelled and set again |
| A look's model run fails | `Looks.look` | events claimed by it | release them (`look` back to NULL) |
| ky restarts mid-look | Durable Object eviction | a run claimed, never wrote `ky_look_runs` | nothing; the next `claim` takes that run's events too (`look NOT IN ky_look_runs`) |
| A look row says `start` | `decide` | ref known, starts today under `STARTS_A_DAY`, pace eager or balanced | new chat by ky with the drafted prompt; `ky_starts` row; a post naming it |
| The map tool adds or moves an item | main chat, dream, look | state change allowed | `ky_map` row; `done` is terminal |

## Invariants

1. **Once per event.** An event is claimed by at most one look; a failed or restarted look gives it back; a claimed event is never shown twice. A restart after the run recorded its answer and before it posted loses it (the price of never twice).
2. **Silent when nothing changed.** A heartbeat with the same fingerprint as the last run and no waiting event makes no model call.
3. **Bounded.** Heartbeat, event and booked runs that reach the model stay within the day's budget, which stays between half and twice the pace's base; scheduled looks are not counted and always run.
4. **Quiet is quiet.** Pace quiet books no heartbeat, no event look and no next look, and its budget is 0; events wait for the next look time.
5. **Cap holds.** Every look trigger passes `host.allows("look")` before any model call.
6. **Once per post.** A post id (`look:<date>:<time>:<ref>`) is delivered once (`Delivery.deliver` dedupes by id).
7. **Starts are rare and visible.** At most `STARTS_A_DAY` starts a day; each start makes a chat the user can see and a post linking it.
8. **Map states.** `open → doing → waiting → done` with any non-done move allowed; `done` never changes.
9. **One booking.** At most one `next` alarm is set, between 15 minutes and 4 hours ahead, inside the waking window, no later than what was asked or 30 minutes before the first due date in reach.

## Proof strategy

| Claim | Proof |
| --- | --- |
| 2, 3, 4 | property tests over `shouldAsk` and `heartbeats` (`test/invariants/pace.test.ts`) |
| 1 | TLA+ model of claim / release / a restart mid-look / one look at a time (`.claude/skills/verify-formal-looks`), plus `test/invariants/look-events.test.ts` over the real store |
| 5, 6 | existing `looks.test.ts` and `test/invariants/delivery.test.ts`; a new case for heartbeats under the cap |
| 7 | property test over `decide` with `start` rows |
| 8 | property test over the map's `move` |
| 9, and 3 for the budget | property tests over `nextAt`, `budgetOf` and `askedNext` (`test/invariants/pace.test.ts`); `looks.test.ts` books, replaces and clears the real alarm |
