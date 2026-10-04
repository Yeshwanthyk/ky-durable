# ky primitives: the plan

Single user. One Durable Object (`PiAgent "me"`, src/server.ts:72) is the brain and the only source of truth.
Everything else is a place it reaches. This revises the first draft after Fable's review
and the Quint models (see `quint/README.md`). For the current system with file:line cites, see `current-map.md`.

## Where things run today

| Place | What runs there | State it owns | Reached by |
|---|---|---|---|
| Browser | React client | none durable (snapshot on connect) | WS → DO |
| Worker | auth, `/api/files`, routing | none | HTTP |
| **DO `PiAgent`** | pi harness (main, side chats, subagents), memory, task feed, chats, settings, machine inbox, workspace fs | all SQLite tables | — |
| Dynamic Worker (`LOADER`) | `exec` sandbox over /workspace; git only | none | binding |
| Browser Rendering (`BROWSER`) | Kitesurf `browse`, subagents only | none | binding |
| R2 `FILES` | screenshots from machine tasks | blobs | binding |
| Executor (SaaS) | apps over MCP | their side | HTTPS |
| OpenCode Go | fallback / subagent model | — | HTTPS |
| **Mac: VibeProxy** | Claude (subscription) as Messages API | — | Workers VPC tunnel |
| **Mac: ky-runner** | Claude Code sessions | runs, outbox, handled seqs (memory) | outbound WS |

## Primitives (7, one new)

1. **Brain**: the DO. Conversations, policy, prompt. `server.ts` becomes composition only, and the prompt moves to `prompt.ts`.
2. **Models**: `models.ts` owns the catalog, slots and `resolve(slot)` with fallback. A provider is an HTTP endpoint
   speaking a known API. `vibeProxy({ binding, origin, api, name })` is a factory, one per tunnel.
   Model traffic **never** rides the runner socket.
3. **Memory**: unchanged (OptMem on SQLite, main conversations only).
4. **Sandbox**: the DO workspace plus `exec`. Cloud, always on, no network.
5. **Browser**: Kitesurf, for the logged-out web. A node's own browser would be a node tool, not this primitive.
6. **Apps**: Executor MCP. It must stop retrying unsafe calls and must pass the abort signal.
7. **Node** (renames "machine"; new): any computer that dials in with the runner. Its `hello` carries a manifest:
   `{ protocol: 1, name, os, tools: [...], models: [...] }`, stored in `ky_machines` along with `last_error`.
   - **Node task**: a long agent session (today's machine task). Recorded in `ky_tasks`, reports later.
   - **Node tool**: one pi tool whose handler runs on a node. It blocks the turn with a deadline.
   - **Node model**: the node serves a model over its own VPC tunnel (primitive 2).

**Automations** are not a separate primitive. They are the Agents SDK `Scheduler` (a Lifecycle capability, `@experimental`) on the DO,
with one callback that submits to the main chat.

### Dropped from the draft
- **Jobs table**: `ky_tasks` already is the durable record of delegated work, with an idempotent id. Instead fix its row
  shape: replace the overloaded `session`/`worker` with `kind` (cloud | node | automation), `target`, and `ref` JSON.
- **`defineCapability`**: pi-durable's `defineExtension` (tools, sections, tasks, hooks) is the extension contract.
  Placement is just a property of the `nodeTool()` helper.
- **Node work as pi tasks**: a pi task can only park while waiting on other tasks, and `runtime.sleep` is in memory,
  so hours-long node sessions belong in the inbox and feed.

## Contracts

```ts
// node tool: schema in the DO, handler on the node
nodeTool({ name: "apple_reminders", os: "darwin", description, parameters })
// → defineTool({ replay: "unsafe", execute(args, { signal }) {
//      online node with this tool in its manifest? else return "node offline" at once (no queueing)
//      enqueue { type: "call", id: toolCallId, tool, args } in ky_machine_inbox
//      race: { type: "return", id } | 90s deadline | signal → enqueue { type: "stop-call", id }
//   } })
// runner/tools/apple-reminders.ts: export const apple_reminders = async (args) => osascript(...)
// main-only: add to the subagent tool filter (mainOnly)

// automation
scheduler.schedule("0 8 * * *", "fire", { id })                  // ky_automations row holds prompt + enabled
fire({ id }, slot) → harness.submit(ROOT_SESSION, prompt, {
  operationId: `automation:${id}:${slot}`, whenBusy: "followUp" }) // the reply is the update
```

## Rules the state models force (Quint)

**Runner protocol.** Today's code fails 6 invariants (`quint/runner_protocol.qnt`, module `current`). With all 6 fixes
on there are no violations (module `fixed`: 6 replays plus 300k simulated traces of 40 steps). Turning off any single fix except
fencing brings a violation back. Fencing is redundant in the model but cheap; keep it for DO eviction mid-`#finish` and submit retries.
The evidence is simulation, not proof: `quint verify` needs Java 21 and this machine has 17.

1. **Flush first.** The runner sends its outbox before `hello`. Otherwise reconcile reports "interrupted" and then the real result reports again.
2. **Fence.** Reports carry the turn. The DO drops reports for a closed turn and submits with operationId `task:turn`.
   Without this, `stop()` racing an in-flight ack gives "stopped", then "done".
3. **Durable handled.** The runner persists handled seqs. Otherwise a lost ack plus a restart runs the task twice.
4. **Safe stop.** `stop()` withdraws only runs never sent. A run arriving for a task being stopped is queued, not steered into the dying session.
5. **Reconcile queued too.** `hello` closes open tasks (queued **or** working) that have no unacked runs.
   Otherwise a result lost before any session report leaves the task stuck at "queued".
6. **Ordered delivery.** `#enqueue` re-sends all pending rows in seq order. Otherwise a follow-up can run before the first run.

Also, outside the model: one socket per node name (a duplicate `hello` replaces the old socket).

**Node tool** (`quint/remote_tool.qnt`). The naive design fails 4 invariants, and the chosen design passes them.
- The job carries its absolute deadline, and the node refuses to start after it.
- The node keeps durable started/done marks per job id and never re-runs a job (a reminder is not idempotent).
- The deadline lives in SQL plus a DO alarm, not an in-memory timer. A re-invoked tool finds its row by call id.
- Expiry or abort says "not run" only if the job was never sent; otherwise it says "unknown".
  An abort racing a job the node already received **cannot** be prevented, so never tell the model "cancelled".

**Automations** (`quint/automations.qnt`). The naive design breaks every invariant. The design holds in 200k traces,
and turning off any one of its 8 fixes breaks it.
- One row per (automation, slot), with the spawn keyed by slot, so a doubled alarm fire can't run a slot twice.
- After downtime, run only the latest due slot and record the missed ones as `skipped` (no silent drops, no burst).
- The spawn re-checks `enabled`. Delete cancels pending and unposted runs.
- Skip (and record) a slot whose previous run is still active.
- A recovery scan on wake restarts stranded `pending` rows. It only works because spawns are keyed by slot.
- Post with a stable operationId `auto:<id>:<slot>`, and a repeat fire never rewrites an existing slot's history.

Because of this, automations need a small `ky_automation_runs (automation_id, slot, state)` table on top of the Scheduler.
The Scheduler only supplies the alarm.

**Open design call: should a node tool block the turn?** Fable recommended blocking with a 90s deadline. The Quint subagent
recommends "started, then report later": both shapes hold, but blocking also depends on pi re-invoking the tool with the same call id
after eviction, and it holds up the turn. A reasonable split is to block for quick, bounded tools (create a reminder) and report later
for anything slow, behind the same job row, deadline alarm and node-side dedupe.

## Gaps Fable flagged

- **One `KY_TOKEN` everywhere.** It sits in every Claude Code child's env under bypassPermissions. Split it:
  `KY_RUNNER_TOKEN` for runner sockets and `/api/files` uploads, and keep `KY_TOKEN` for the UI.
- **Name collisions.** `#deliver` sends to every socket tagged with the name (machines.ts:138-150).
- **No protocol version.** Add one integer in the manifest. A stale runner answers "unknown tool".
- **UI submits carry no id** (use-pi-session.ts:154-157), so a resend can double-submit.
- **Hard-coded Mac.** PREAMBLE and `ORIGIN` name the Mac. They should come from the manifest and the per-tunnel config.

## Path (each step ships alone)

1. Harden the runner protocol: the six Quint fixes above, plus one socket per node name.
2. Manifest plus split auth (`KY_RUNNER_TOKEN`). Add `manifest` and `last_error` to `ky_machines`.
3. Node tools: `call / return / stop-call` frames, `src/nodes.ts` (`nodeTool`), `runner/tools/apple-reminders.ts`, main-only.
4. Automations: `src/automations.ts`, `ky_automations`, an `automation` tool (create/list/pause/delete), and `Scheduler` via `.use`.
5. Extract `models.ts` with the per-tunnel provider factory. A second node's model is then one `vpc_services` entry plus one line.

Steps 1-2 also fix today's bugs, so do them even if nothing else lands.
