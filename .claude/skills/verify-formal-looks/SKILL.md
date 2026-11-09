---
name: verify-formal-looks
description: Model-check how ky's looks take the mail that arrived between them (claim, release, a restart mid-look, one look at a time) with TLA+/TLC, and rerun the linked property test against the real LookEvents store. Use after changing src/dreaming/events.ts (claim, release, ran, add), Looks.run or Looks.look in src/dreaming/looks.ts (the `looking` guard, the order of claim, ask, ran and post), arrived in src/server.ts, or anything else that writes ky_look_events or ky_look_runs.
---

# Verify looks taking the mail that arrived

Between look times, mail ky triaged waits in `ky_look_events` for the next look (a look time, a heartbeat, or an
event look booked 5 minutes after the mail). A look claims what waits, asks the model with it in the digest
("Arrived since the last look"), records the run in `ky_look_runs`, and posts. Two harms follow: the same mail put
in front of the user twice, and a mail that no look will ever take. This skill holds a TLA+ model of that flow, its
statechart, and a property test that drives the real store through the same actions.

## Scope

Sync commit: `670999e8` plus the night-shift change that adds `src/dreaming/events.ts`. Move it to that change's
commit once it lands.

| Model part (Looks.tla) | Code |
|---|---|
| `Arrive` | `src/server.ts` `arrived` → `LookEvents.add` (insert-or-ignore by `mail:<id>`) |
| `Start`: the `looking` guard, then `Claimable` → `owner`, `took` | `src/dreaming/looks.ts` `run` (the `looking` Ref) and `look` up to `ask` (no await between); `src/dreaming/events.ts` `claim` (`look IS NULL OR look NOT IN (SELECT look FROM ky_look_runs)`) |
| `Fail` | `look`: `Effect.onError` and the `answer === undefined` branch call `events.release(id)` |
| `Answer` | `look`: `events.ran(id, trigger, read, now)` after `ask` returns |
| `Post` | `look`: `post(...)`; the mail reaches the user through the rows the model wrote from the digest |
| `Crash` | Durable Object eviction while a look awaits `ask` or `post`: no `onError`, no `ensuring`; `looking` resets, SQLite stays |

Also in scope: a second caller of `claim`, anything that clears `looking` early, or anything that writes
`ky_look_runs` before `ask` returns (it would make a dead run look answered).

## Property

- **ShownOnce**: no mail reaches two posts. *Harm:* the user is told about the same mail twice.
- **NoneStranded**: every mail that arrived and was not shown is held by a run still going, or by a run that got its
  answer (`ran`), or the next look's `claim` takes it. *Harm:* a mail no look ever mentions.

A pass covers two looks (a look time and a heartbeat) with two runs each, two mails, and one eviction at any point
of a run (`Looks.cfg`, 8,412 states, depth 15). **Not covered:** the budget and fingerprint (`shouldAsk`, property
tested in `test/invariants/pace.test.ts`), post ids and delivery dedupe (`test/invariants/delivery.test.ts`),
whether the model mentions a mail it was given, and more than one Durable Object instance (ky has one).

## Run

From the repo root (about 5s for the check, 1s for the test; needs Java 11+; `tlc_chart.py` fetches
`tla2tools.jar` 1.7.4 once and pins it by sha256):

```
.claude/skills/verify-formal-looks/run.sh          # every rule, the chart comparison, then the linked tests
.claude/skills/verify-formal-looks/run.sh breaks   # each Break_*.cfg must fail (about 10s)
```

`tlc_chart.py` is a copy from the invariants skill, version `tlc_chart 3 (TLC 1.7.4)`.

## Chart

`chart.viz` holds the intended stories, drawn before the model: a look takes the waiting mail, asks, and posts it
once; a failed look gives it back and the next one shows it once. The run writes `chart.checked.viz`. Baseline:
`look` and `retry` work, `twice` and `stranded` are never reached, and no step is undrawn.

## Read the result

- **Model fails**: `tlc_chart.py` prints the shortest trace, one action per step. The Scope table maps each action to
  code. To replay it, write the trace as `Op[]` in `test/invariants/look-events.test.ts` (arrive, start, fail,
  answer, post, crash), the way the second test does.
  - **Product defect**: the replay fails the same way. The first run of this model found one: `claim` took only
    `look IS NULL`, so an eviction while a look awaited the model left its mail claimed for good (`Break_noSweep`,
    3 steps: arrive, start, crash).
  - **Modeling error**: the replay cannot take a step, or passes. Two of them while writing this: `NoneStranded` first
    demanded the mail be shown within the bound (a restart on the last run "stranded" it, but the code's next look
    takes it), and `Post` first counted the mail the run held at post time, not what its claim returned, which hid
    the double show `Break_noGuard` now catches.
- **Linked test fails**: fast-check prints a shrunk op list, already a replay against the real store. The message
  names the property.
- **Reach check fails** (`expected 0 to be greater than 0`): the generator stopped reaching restarts mid-look, so a
  pass would mean nothing. Fix the generator; don't loosen the check.

## Linked tests

- `test/invariants/look-events.test.ts` runs the real `LookEvents` over `node:sqlite` with the model's actions, one
  look at a time as `looking` keeps it. The oracle counts what each post showed from what its claim returned. Run it
  with `npx vitest run --config test/invariants/vitest.config.ts test/invariants/look-events`.
- `src/tests/looks.test.ts` runs the real PiAgent: the event look claims once, and a heartbeat stays silent unless
  something changed. Run it with `pnpm test src/tests/looks`.

Scratch breaks in `src/dreaming/events.ts` `claim`, each seen red, and the matching model variant:

| Break | Linked test | Model |
|---|---|---|
| `WHERE look IS NULL` only | NoneStranded, `[arrive, start, crash]` | `Break_noSweep` |
| no `WHERE` at all | ShownOnce, `[arrive, start]` then the last look | `Break_claimAny` |
| `run` without the `looking` check (in looks.ts) | — (the harness keeps one look at a time) | `Break_noGuard` |

Dropping `events.release` alone is not a break: the next claim takes a failed run's mail anyway, since it has no
`ky_look_runs` row. Release only gives it back sooner.

## Update

When a change alters this on purpose (claim per kind, a second instance, recording `ran` earlier):

1. Change `Looks.tla` from the code in the same change, so each action still cites code in the Scope table.
2. Change `chart.viz` if the stories change, then run `run.sh` until the stories work.
3. Run `run.sh breaks`, adding a `Break_*.cfg` for any new property, and make one scratch break in the code and
   watch the linked test go red.
4. Move the sync commit only after all of that.

## Known findings

- **A restart mid-post loses the mail it held** (allowed by NoneStranded). Once `ran` is written, `claim` no longer
  takes the run's mail, so an eviction during `post`'s awaits drops whatever rows had not gone out. Writing `ran`
  after `post` instead trades this for showing the mail twice. Replay: `[arrive, start, answer, crash]` in the
  linked test's harness ends with the mail in `lostInPost`.
- **An event look that fires during another look is skipped** (liveness, not checked). `run` returns while `looking`
  is set, and the mail waits for the next heartbeat or look time. Quiet pace books no heartbeats.
