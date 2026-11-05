---
name: verify-formal-chats
description: Model-check how ky's chats message each other (send to another chat, notify, the answer coming back) with TLA+/TLC, and rerun the linked property test against the real chats tool. Use after changing src/chats/tool.ts, src/chats/chats.ts (ky_chat_waits), src/chats/contract.ts refusals, startedByUser or tookIn in src/history/wiring.ts, the chats parts in src/server.ts, or anything else that submits a message into a chat or decides whose turn it is.
---

# Verify chats that message each other

Chats send each other messages through the chats tool. With `notify`, the receiving chat's answer comes back to
the chat that asked. Two harms follow from that: chats waking each other in a loop, and the answer coming back
twice or before it exists. This skill holds a TLA+ model of that flow, its statechart, and a property test that
drives the real tool through the same actions. Run it after any change in its scope.

## Scope

Sync commit: `1e71304b` (the model and test describe the code at this commit).

| Model part (Chats.tla) | Code |
|---|---|
| `Send` gates: OpenedByAnother, ThisChat, NotTheUsersTurn, NoticeNotTheUsersTurn | `src/chats/tool.ts` `call` (the refusals in order), `steer`, `create` |
| `Send` writes the wait row before it submits | `src/chats/tool.ts` `steer`/`create` call `parts.chats.wait` before `parts.steer`; `src/chats/chats.ts` `wait` |
| `Notify`, `Settle` | `src/chats/tool.ts` `tellWaiting` (the onYield hook), request id `chat-notice:<send's request>`; `src/chats/chats.ts` `waitsFor`, `settle` |
| `w.id \in placed[c]` | `taken` part = `src/history/wiring.ts` `tookIn` (`pi_submissions.$.entry` set) |
| `Authority(c)` | `userStarted` part = `src/history/wiring.ts` `startedByUser` (newest pi.user entry has a UUID request id) |
| `inbox`, `submitted`, `Place`/`Start`/`Join`, `Yield`/`Answer` | pi-durable: `submit` dedupes a repeated `requestId`, queued inputs place at the next boundary, onYield runs before the commit and reruns after a crash |

Also in scope: new code that submits into a chat (a new request-id prefix) or changes what `isOwnRequest` accepts. Either one can hand authority to a turn the user didn't start.

## Property

- **BoundedChain**: every message is at most 3 hops from something the user wrote. The hops are user (0) → send (1) → answer back (2) → steer to a chat that one opened (3), and that last chat sends nothing. *Harm:* chats keep waking each other after one message.
- **NoticeOnce**: each send with notify brings back at most one notice. *Harm:* the same answer lands twice in the asking chat.
- **NoticeAfterAnswer**: the notice goes out only once the target took the message in. *Harm:* the asking chat is told about an answer to something the target never saw.

A pass covers the main chat, one side chat the user opened (Reading), and one side chat the main chat opened. It
allows up to 2 user messages and 3 sends across all chats (`Chats.cfg`, 1.8M states). Every queued message can be
the newest at a boundary, and the hook can rerun or be lost. **Not covered:** liveness (whether a notice ever goes
out), more chats, and the text of the messages.

## Run

From the repo root (about 35s; needs Java 17+, and `tlc_chart.py` fetches `tla2tools.jar` 1.7.4 and pins it by sha256):

```
.claude/skills/verify-formal-chats/run.sh          # chart run, full-bound check, linked test
.claude/skills/verify-formal-chats/run.sh breaks   # each broken variant must fail its property (3s)
```

`tlc_chart.py` is a copy from the invariants skill, version `tlc_chart 3 (TLC 1.7.4)`.

## Chart

`chart.viz` holds the intended stories, drawn before the model was written. The run writes `chart.checked.viz`,
which marks each story works / `!` bug / `+` fixed / `?` unreached and lists each arrow where the model and the
chart disagree. Render it with the viz skill. Baseline: write, ask, back and once all work, the three harm nodes are
never reached, and there are no disagreements.

## Read the result

- **Model fails**: TLC prints a trace. Each step is an action, and the Scope table maps each action to code. To
  replay it, write the trace as `Op[]` steps in `test/invariants/chats-messaging.test.ts`, the way the second test
  does. Use write, place, send (with its `to`, action and notify), yield (with crash), rehook and answer.
  - **Product defect**: the replay fails the same way.
  - **Modeling error**: the replay can't take a step, or passes. Fix the model and say what was wrong. The first
    draft of this model counted a notice's hops from the target's newest message instead of from the send, and
    found a "loop" the code can't make.
- **Linked test fails**: fast-check prints a shrunk counterexample, already a replay against the real tool. The
  harm string names the property.
- **Reach check fails** (`expected 0 to be greater than 0`, or `longest` below 3): the generator stopped reaching
  notices or the 3-hop chain, so a pass would mean nothing. Fix the generator. Don't loosen the check.

## Linked tests

- `test/invariants/chats-messaging.test.ts` runs the real `ChatList` and `chatsExtension` (tool and onYield hook)
  over a harness that queues, places and dedupes like pi-durable. The ops are the model's actions, including a
  hook that crashes after its notice and before settling. The oracle checks the three properties from what the
  chats did, never from the tool's request ids. Run it with
  `npx vitest run --config test/invariants/vitest.config.ts test/invariants/chats-messaging` (about 3s, a random
  seed each run).
- `src/tests/chats-tool.test.ts` runs the real PiAgent: title addressing, and notify end to end (one
  `chat-notice:` in the main chat, no wait left, and the notice's turn can't send on). Run it with
  `pnpm test src/tests/chats-tool`.

Scratch breaks in `src/chats/tool.ts` and what the linked test reports; each matches a `Break_*.cfg`:

| Break | Linked test | Model |
|---|---|---|
| drop `if (send.notify && !parts.userStarted(from))` | BoundedChain, 4 hops | `Break_notifyAnyTurn` |
| drop `if (!opener && !parts.userStarted(from))` | BoundedChain, 4 hops | `Break_sendAnyTurn` |
| notice id `chat-notice:${wait.request}:${Math.random()}` | NoticeOnce | `Break_freshNoticeId` |
| drop `if (!parts.taken(target, wait.request)) continue;` | NoticeAfterAnswer | `Break_noTakenCheck` |

## Update

When a change alters this behavior on purpose (another hop, a new gate, a new kind of message):

1. Change `Chats.tla` from the code in the same change, so each action still cites a symbol in the Scope table.
2. Change the chart if the stories change, then run `run.sh` until the stories work.
3. Run `run.sh breaks`, adding a `Break_*.cfg` for any new property. Make one scratch break in the code and watch
   the linked test go red.
4. Move the sync commit forward only after all of that.

## Known findings

- **A lost hook waits for the next answer** (liveness, not checked). If the hook dies and the harness doesn't rerun
  it, the wait row stays. The notice then goes out on the target's next answer, carrying that answer's text. The
  model's `Answer` allows this, and no property rejects it.
- **A chained hook may notice early (unconfirmed).** `tellWaiting` reads `taken` from `pi_submissions`. A run continued by another
  hook commits before the message's entry is set. The model assumes onYield sees what was placed in the turn.
  Replay: none yet; it would need a hook-continued run in `src/tests/`.
