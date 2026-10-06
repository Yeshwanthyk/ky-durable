# Quint models of ky's state machines

Each model has a `current`/`naive` instance, a `fixed`/`design` instance, and per-fix ablations.

Quint 0.33.0 via `npx -y @informalsystems/quint`. `quint verify` was unavailable: Apalache needs Java 21 and Java 17 is installed. Evidence is simulation plus exact replays; "holds" means no violation in N traces, not a proof.

Assumptions: FIFO socket; node and DO share a clock; pi-durable re-invokes a tool with the same call id after eviction.

## 1. Machine protocol: `runner_protocol.qnt`, `runner_protocol_fixed.qnt`

**State:** `srv{status, curTurn, closed, inbox, reports}`, `net{conn, down, up}`, `rn{job, handled, outbox, restarts}`, ghosts `g`.

| From | Trigger | Actor | Precondition | Write | Publication | Recovery |
|---|---|---|---|---|---|---|
| idle/done | UserStart | DO | - | inbox+=run; queued | send if connected | hello redelivers |
| open | UserSend | DO | - | inbox+=steer | new row only (machines.ts:135) | hello redelivers |
| open | UserStop | DO | - | withdraw run rows; if queued, finish "stopped before it started" | stop row | - |
| - | RunnerRecv | runner | row at head | handled+=id; start/steer/stop | ack, dropped offline | none (in-memory) |
| running | RunSession/Progress/Result | runner | job live | - | outbox report | flushed *after* hello |
| - | ServerRecv | DO | up non-empty | ack deletes row; result: `#finish`, random opId | feed | - |
| - | Disconnect/RunnerRestart | env | - | drop queues; restart clears `handled` | - | Connect |
| - | Connect/Keepalive | runner | - | - | hello{active} | fails *working* tasks absent from active |

The model's runner answers each steered message with its own result (`RunResult` counts `pending` down by one). Claude Code may instead fold a message sent mid-turn into the running turn, so one result can answer several. The runner now counts the messages Claude Code echoes back (`--replay-user-messages`) and ends the run on the first result after all of them are taken in.

**Invariants:**
- AtMostOneTerminalReportPerTurn
- NoTerminalFlip
- NoClosedTurnReopens
- NoFalseInterrupt
- NoOutOfOrderExecution
- NoDuplicateExecution
- NoRunAfterStoppedReport
- NoSteerIntoStoppedRun
- QuiescentRecoverable (once quiet, no task is open forever)

```
$ quint typecheck <each .qnt>                      ok (all four)
$ quint test runner_protocol.qnt --main=current
  6 passing (95ms)                                 # every counterexample replays
$ quint run runner_protocol.qnt --main=current --invariant=<each> --max-samples=20000 --max-steps=20 --seed=7
[violation] Found an issue                         # all 9 invariants
```

Shortest violating `--max-steps`: 4 (RunAfterStopped), 6 (OutOfOrder), 8 (terminal-report trio, Duplicate), 10 (Quiescent), 12 (SteerIntoStop), 17 (FalseInterrupt).

**Counterexamples on today's code:**
1. **Stop race.** The user stops while the run's ack is in flight. `stop()` withdraws the row and reports "Stopped before it started", but the runner runs the job anyway. Status revives; a second report says done.
2. **Hello before outbox.** A result finishes offline. On reconnect, `hello{active:[]}` lands first and reports "Interrupted". Then the outbox result reports done.
3. **Duplicate.** Ack lost, runner restarts with empty `handled`, hello redelivers: runs twice.
4. **Steer into stop.** A send after a stop goes to the dying process's stdin and is lost.
5. **Stuck queued.** The socket drops before any session report arrives. The hello closes only *working* tasks, so the task stays queued forever.
6. **Reorder.** Start offline; runner connects; follow-up sent before the hello is processed. `#enqueue` sends only the new row, so the follow-up runs first.

Checking fixes surfaced a seventh, **stale keepalive**: a 30s hello sent before a run row arrived declares that turn interrupted. Rule: hello closes only tasks with no unacked run rows (sound given FIFO).

| Flag | Correction | Boundary test |
|---|---|---|
| FLUSH_FIRST | On open, flush the outbox before hello. Buffer acks offline. | Finish offline, reconnect: exactly one `done`, no "Interrupted". |
| DURABLE_HANDLED | Persist handled row ids before acking. | Kill the runner between exec and ack: one execution. |
| SAFE_STOP | Never finish a task whose run row was sent. Send stop and await the result. Reject steers to a stopping job. | Stop with ack in flight: one terminal report, no run after. |
| RECONCILE | Hello closes queued *or* working tasks that are absent from active and have no unacked run rows. | Drop the socket before the session report: the task ends failed, not queued. |
| ORDERED_DELIVERY | `#enqueue` resends the whole pending inbox in order. The runner dedupes. | Start offline, send before hello: the order is 1, 2. |
| FENCED | Reports carry the turn. `#finish` uses opId `task:turn` and compare-and-sets the open turn. | A stale result after the next turn starts is ignored. |

```
$ quint test runner_protocol_fixed.qnt --main=fixed
  6 passing (107ms)
$ quint run runner_protocol_fixed.qnt --main=fixed --invariant=Safety --max-samples=300000 --max-steps=40 --seed=4242
[ok] No violation found (100680ms at 2980 traces/second).
$ quint run ... --main=no_<flag> --invariant=Safety --max-samples=100000 --max-steps=30 --seed=5
no_flush_first / no_durable_handled / no_safe_stop / no_reconcile / no_ordered_delivery: [violation] Found an issue
no_fence: [ok] No violation found (28052ms at 3565 traces/second).
```

Fencing is redundant given the other fixes; keep it for unmodeled DO eviction mid-`#finish` and submit retries. Without FLUSH_FIRST it yields one report, the wrong one.

## 2. Remote tool pinned to a machine: `remote_tool.qnt`

Shapes: **(a) block** waits for the result; **(b) report** returns "started" and posts the result later.

**State:**
- `clock`
- `job{state, deadline, outcome, needPost}` (SQL)
- `node{online, executing, effectDone, memHandled, crashes}`
- `net`
- `cons{waiter, timer, consumed, told, ops, evictions}`
- ghosts `g`

| From | Trigger | Actor | Precondition | Write | Publication | Recovery |
|---|---|---|---|---|---|---|
| none | Call | agent | - | row open, deadline now+D | send job; (a) waiter, (b) "started" | resend on connect |
| open | Expire/Abort | alarm/user | open | row closed with outcome | "not run" or "unknown" | - |
| open | ServerRecv | DO | result on wire | CAS: only an open row takes it | wake waiter / needPost | late result is ignored |
| done | Consume/Post | DO | waiter / needPost | consumed++, opId | tool result / message | retry Post |
| - | Evict | env | - | lose timers and waiters | - | alarm; re-invoke |
| - | NodeRecv/Effect/Finish/Crash | node | - | effect, memHandled | result | redelivery |

**Invariants:**
- ResultConsumedAtMostOnce
- NoExecutionAfterExpiryOrAbort
- TruthfulOutcome ("not run" implies zero effects)
- NoOrphanResult
- NonIdempotentEffectAtMostOnce
- NoStuckWaiter

`Design` is all of these except NoExecutionAfterExpiryOrAbort.

```
$ quint test remote_tool.qnt --main=design_block   5 passing (64ms)
$ quint test remote_tool.qnt --main=design_report  3 passing (41ms)
$ quint test remote_tool.qnt --main=naive          4 passing (56ms)
$ quint run remote_tool.qnt --main=design_block  --invariant=Design --max-samples=200000 --max-steps=30 --seed=3
[ok] No violation found (50901ms at 3929 traces/second).
$ quint run remote_tool.qnt --main=design_report --invariant=Design --max-samples=200000 --max-steps=30 --seed=3
[ok] No violation found (49848ms at 4012 traces/second).
$ quint run ... --main=design_{block,report} --invariant=NoExecutionAfterExpiryOrAbort ...
[violation] Found an issue
$ quint run ... --main={naive,block_no_resume,report_random_opid,report_no_alarm} --invariant=Design ...
[violation] Found an issue   (all four)
```

**Counterexamples, with corrections and boundary tests:**
- **Abort race (both shapes, unavoidable).** Esc is pressed while the job is on the wire, and the node runs it. Correction: report "unknown, may have run".
- **False "not run" (naive).** The job expires and the node starts it late. Correction: the node refuses a job past its deadline; expiry says "unknown" unless confirmed. Test: deliver after the deadline and expect zero effects.
- **Double effect (naive).** The node crashes after the effect and before the ack, and redelivery reruns it. Correction: durable node-side dedupe by job id.
- **Orphan (naive, block_no_resume).** Eviction fails the call with "interrupted" while the job keeps running. Correction: (a) re-invoke with the same call id, or (b) post the result as a message. Test: evict mid-job; result consumed once.
- **Double post (report_random_opid).** A post is retried after eviction. Correction: opId `remote:<jobId>`. Test: evict between post and commit, and expect one message.
- **Stuck waiter (report_no_alarm).** An in-memory timer dies on eviction. Correction: put the deadline in a DO alarm. Test: evict past the deadline; outcome delivered.

**Verdict: prefer (b).** It needs a durable alarm, stable opId and `unposted` flag with retry; no orphan risk. (a) also needs re-invocation on resume and blocks the turn.

## 3. Recurring automations on one DO alarm: `automations.qnt`

**State:**
- `clock`
- `auto{exists, enabled, nextSlot}`
- `alarm{armed, at, refires}`
- `rows[{slot, state, posted}]` (SQL)
- `ledger` (slot to `run | skipped:*`)
- `cont` (in-memory spawn continuations)
- `restarts`
- ghosts `g`

| From | Trigger | Actor | Precondition | Write | Publication | Recovery |
|---|---|---|---|---|---|---|
| armed | AlarmFire/Refire | DO | at <= clock | latest due slot `run`, earlier `skipped:missed`, busy `skipped:overlap`; re-arm | - | refire is at-least-once |
| pending | Spawn(s) | DO | row pending, enabled, exists | row running, keyed by slot | start subagent | recovery scan |
| running | Finish | subagent | - | row done | - | - |
| done | Post | DO | exists, unposted | posted, opId `auto:slot` | message | retry |
| any | Disable/Enable/Delete | user | - | enable: `skipped:disabled`, no backfill, re-arm; delete cancels pending, running and unposted | - | - |
| any | Restart | env | - | `cont` lost | - | scan pending/unposted rows |

**Invariants:**
- AtMostOneRunPerSlot
- AtMostOnePostPerRun
- NoStartAfterDisableOrDelete
- NoPostAfterDelete
- NoLostSlotWithoutRecord
- NoStrandedRun
- NoOverlap
- LedgerMatchesRows

```
$ quint test automations.qnt --main=design        8 passing (114ms)
$ quint test automations.qnt --main=naive         7 passing (100ms)
$ quint test automations.qnt --main=scan_unkeyed  1 passing (19ms)
$ quint run automations.qnt --main=design --invariant=Design --max-samples=200000 --max-steps=30 --seed=9
[ok] No violation found (40853ms at 4896 traces/second).
$ quint run ... --main=no_<each of 8 flags> --invariant=Design --max-samples=50000 --max-steps=25 --seed=9
[violation] Found an issue   (all eight)
```

**Counterexamples (naive replays), with corrections and boundary tests:**
- **Refire.** The alarm fires twice and the slot runs twice. Correction: an idempotent row insert keyed by slot. Test: fire twice and expect one row.
- **Late alarm.** The alarm fires 3 periods late, which runs 3 times or silently drops 2 slots. Correction: coalesce and record the misses. Test: expect one run plus 2 `skipped:missed`.
- **Disable race.** A spawn that was already scheduled starts after disable. Correction: spawn re-checks `enabled` in its transaction. Test: disable between fire and spawn; no start.
- **Delete in flight.** A run finishes after delete and posts. Correction: delete cancels the row, and the post checks that the automation exists.
- **Stranded.** Eviction between the insert and the spawn leaves the row pending forever. Correction: a recovery scan on alarm and on start. Test: kill the DO there and expect one run.
- **Unkeyed scan (scan_unkeyed).** Scan and original continuation both spawn. Correction: keyed spawn.
- **Overlap.** Next slot starts mid-run. Correction: skip, record `skipped:overlap`.
- **Double post.** A retry after eviction posts twice. Correction: opId `auto:<id>:<slot>`. Test: retry the post and expect one message.
- **no_dedupe_slot (sim).** After enable, a fire records slot 2 as `run` (pending), and a refire overwrites the ledger to `skipped:overlap`. Keyed spawn alone hides this. Correction: refire is a no-op for a slot that already has a row.

Policy: disable stops future starts (a started run finishes and posts); enable does not backfill.
