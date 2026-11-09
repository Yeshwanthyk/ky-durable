---- MODULE Looks ----
\* How a look takes the mail that arrived since the last one (docs/research/proactivity/night-shift-model.md,
\* invariant 1). Code: src/dreaming/looks.ts `run` and `look`, src/dreaming/events.ts `add`, `claim`, `release`,
\* `ran`. `ui` is the chart variable: each look's node on chart.viz.
EXTENDS Naturals, FiniteSets

CONSTANTS Looks,      \* the look times that can fire (a look time, a heartbeat, an event look)
          Mails,      \* mail ids that can arrive
          MaxRuns,    \* runs each look may make
          MaxCrashes, \* times the Durable Object may be evicted
          Break       \* "none", or a scratch break the check must catch (see the Break_*.cfg files)

Runs == Looks \X (1..MaxRuns)

\* An event no look holds: not arrived yet, or waiting (ky_look_events.look IS NULL). Tuples like a run's id.
Absent == <<"absent", 0>>
Waiting == <<"waiting", 0>>

VARIABLES
  ui,       \* look -> "idle" | "asking" | "posting"
  looking,  \* the in-memory `looking` Ref in `run`; an eviction resets it
  runs,     \* look -> how many runs it started (each run's id is `look-<uuid>`: here <<look, n>>)
  owner,    \* mail -> Absent | Waiting | the run that claimed it (ky_look_events.look)
  ran,      \* runs recorded in ky_look_runs
  took,     \* look -> the mail its current run's claim returned: what `ask` put in the digest ("Arrived since")
  shown,    \* mail -> how many posts it reached
  crashes

vars == <<ui, looking, runs, owner, ran, took, shown, crashes>>

Init == /\ ui = [l \in Looks |-> "idle"]
        /\ looking = FALSE
        /\ runs = [l \in Looks |-> 0]
        /\ owner = [m \in Mails |-> Absent]
        /\ ran = {}
        /\ took = [l \in Looks |-> {}]
        /\ shown = [m \in Mails |-> 0]
        /\ crashes = 0

Current(l) == <<l, runs[l]>>

Live(r) == ui[r[1]] # "idle" /\ runs[r[1]] = r[2]

\* #triageMail -> arrived -> LookEvents.add: insert-or-ignore by `mail:<id>`, so a second triage changes nothing.
Arrive(m) == /\ owner[m] = Absent
             /\ owner' = [owner EXCEPT ![m] = Waiting]
             /\ UNCHANGED <<ui, looking, runs, ran, took, shown, crashes>>

\* What `events.claim` takes: waiting (look IS NULL), or held by a run with no ky_look_runs row (look NOT IN ...).
\* It does not ask whether that run is still going: the `looking` guard in Start is what makes such a run a dead one.
Claimable(m) == \/ owner[m] = Waiting
                \/ Break # "noSweep" /\ owner[m] \in Runs /\ owner[m] \notin ran
                \/ Break = "claimAny" /\ owner[m] \in Runs

\* Looks.run: skip while `looking`, set it, then `look` up to `ask` with no await in between: shouldAsk, the
\* fingerprint, and `events.claim(id)` all run in one synchronous stretch.
Start(l) == /\ ui[l] = "idle" /\ runs[l] < MaxRuns
            /\ (~looking \/ Break = "noGuard")
            /\ looking' = TRUE
            /\ runs' = [runs EXCEPT ![l] = @ + 1]
            /\ owner' = [m \in Mails |-> IF Claimable(m) THEN <<l, runs[l] + 1>> ELSE owner[m]]
            /\ took' = [took EXCEPT ![l] = {m \in Mails : Claimable(m)}]
            /\ ui' = [ui EXCEPT ![l] = "asking"]
            /\ UNCHANGED <<ran, shown, crashes>>

\* `ask` fails or answers nothing: Effect.onError / the undefined branch call `events.release(id)`.
Fail(l) == /\ ui[l] = "asking"
           /\ owner' = IF Break = "noRelease" THEN owner
                       ELSE [m \in Mails |-> IF owner[m] = Current(l) THEN Waiting ELSE owner[m]]
           /\ ui' = [ui EXCEPT ![l] = "idle"]
           /\ looking' = FALSE
           /\ UNCHANGED <<runs, ran, took, shown, crashes>>

\* The answer came: `events.ran(id, …)`, then `post`.
Answer(l) == /\ ui[l] = "asking"
             /\ ran' = ran \cup {Current(l)}
             /\ ui' = [ui EXCEPT ![l] = "posting"]
             /\ UNCHANGED <<looking, runs, owner, took, shown, crashes>>

\* `post` delivers the rows the model wrote from the digest, so the mail the run took reaches the user through
\* them, whoever holds the row now. Ensuring clears `looking`.
Post(l) == /\ ui[l] = "posting"
           /\ shown' = [m \in Mails |-> IF m \in took[l] THEN shown[m] + 1 ELSE shown[m]]
           /\ ui' = [ui EXCEPT ![l] = "idle"]
           /\ looking' = FALSE
           /\ UNCHANGED <<runs, owner, ran, took, crashes>>

\* The Durable Object is evicted while a look awaits the model or delivery: no onError, no ensuring; memory is gone,
\* SQLite stays.
Crash == /\ crashes < MaxCrashes
         /\ \E l \in Looks : ui[l] # "idle"
         /\ ui' = [l \in Looks |-> "idle"]
         /\ looking' = FALSE
         /\ crashes' = crashes + 1
         /\ UNCHANGED <<runs, owner, ran, took, shown>>

AllIdle == \A l \in Looks : ui[l] = "idle"

Done == /\ AllIdle /\ \A l \in Looks : runs[l] = MaxRuns
        /\ UNCHANGED vars

Next == \/ \E m \in Mails : Arrive(m)
        \/ \E l \in Looks : Start(l) \/ Fail(l) \/ Answer(l) \/ Post(l)
        \/ Crash
        \/ Done

\* Harm: the same mail is put in front of the user twice.
ShownOnce == \A m \in Mails : shown[m] <= 1

\* Harm: a mail no look will ever show. Every mail that arrived and was not shown is held by a run still going, or
\* the next look can take it, or a run got its answer for it (`ran`): past that point the mail is the post's to
\* deliver, and an eviction mid-post loses it (Known findings in SKILL.md), which is the price of ShownOnce.
NoneStranded == \A m \in Mails :
                  (owner[m] # Absent /\ shown[m] = 0)
                    => \/ owner[m] \in Runs /\ Live(owner[m])
                       \/ owner[m] \in ran
                       \/ Claimable(m)

\* Mail every run that could show it did show, once.
AllShownOnce == \A m \in Mails : owner[m] # Absent => shown[m] = 1
====
