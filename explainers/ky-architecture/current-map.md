# ky: current architecture map

Grounded map of ky as of commit 0800276. Paths are relative to `/Users/yesh/code/personal/ky`. `pi-durable` = `node_modules/@earendil-works/pi-durable`; `agents/pi` = `node_modules/agents/dist/harness/pi`.

## A. Runtime locations

| Location | Transport in / out | Auth | Who initiates | State held | Offline behavior |
|---|---|---|---|---|---|
| **Browser UI** (`src/client.tsx`, `src/use-pi-session.ts`) | WS to `/agents/pi-agent/me?session=<id>` (use-pi-session.ts:64-70); HTTP PUT/GET `/api/files` (server.ts:392-398) | `ky_token` HttpOnly cookie, 1 year (auth.ts:46-61) | Browser | None durable; it rebuilds from a `hello`/snapshot on connect (sockets.ts:225-256) | The agentic loop keeps running server-side, and the UI resyncs on reconnect |
| **Worker fetch** (`PiAgent` module `fetch`, server.ts:380-404) | HTTP from browser / runner | One shared secret `KY_TOKEN`, compared with timingSafeEqual; Bearer or cookie (auth.ts:12-44) | Caller | None | n/a |
| **Durable Object `PiAgent`, name "me"** (server.ts:72, 393; wrangler.jsonc:35-48) | Hibernating WS (sockets.ts:179-207); calls out to R2, LOADER, BROWSER, VPC, executor MCP, opencode | Upstream auth already checked by Worker | Everyone dials *in*; the DO dials *out* only to bindings/HTTP | All state lives in SQLite: pi_* conversation store (agents/pi index.d.ts:296-307), ky_tasks (tasks.ts:51-60), ky_machine_inbox / ky_machines (machines.ts:84-89), ky_chats (chats.ts:32-36), ky_settings (settings.ts:64-65), memo_log / memo_tree (memory.ts:145-149), ky_files (files.ts:38-45), Workspace fs (server.ts:96-108) | Always on. A Lifecycle job + alarm re-wakes sessions with live tasks (agents/pi index.js:340-350, 466-499) |
| **R2 `ky-files`** (wrangler.jsonc:10) | Binding `FILES` | Binding | DO | Blobs at `files/<id>`, 25MB cap (files.ts:19-28, 100-138) | n/a |
| **Dynamic Worker sandbox** (`LOADER`, wrangler.jsonc:14) | Binding | Binding | DO `exec` tool | Ephemeral isolate. Its fs is the DO Workspace at `/workspace` | No network except git over HTTPS "through the host"; no shell or npm (workspace.ts:25-65; server.ts:101-107) |
| **Kitesurf browser** (`BROWSER`, wrangler.jsonc:12) | Binding + CDP | Binding | DO `browse` tool | Per-call session, closed on abort (browse.ts:80-83, 175-199) | Works while the Mac is offline; no logins (browse.ts:5-15) |
| **Executor MCP** (`EXECUTOR_URL`, wrangler.jsonc:23) | Streamable HTTP MCP | Bearer `EXECUTOR_TOKEN` (executor.ts:42-59) | DO | External | 6 min timeout, one retry (executor.ts:28, 71-95) |
| **opencode provider** (server.ts:90) | HTTPS | `OPENCODE_API_KEY` | DO | None | Fallback slot when VibeProxy is down (server.ts:74-89) |
| **Mac: VibeProxy** (`127.0.0.1:8317`) | VPC service `VIBEPROXY` over a cloudflared tunnel with no public hostname (wrangler.jsonc:27-34; vibeproxy.ts:7-21) | `x-api-key` = `VIBEPROXY_KEY` (vibeproxy.ts:79-101) | DO | None | Probed with a 3s timeout and 30s TTL. If it is down, `streamSimple` routes to the fallback (vibeproxy.ts:25-27, 117-129) |
| **Mac: ky-runner** (`runner/ky-runner.ts`) | Outbound WS `${KY_URL}/agents/pi-agent/me?runner=<KY_MACHINE>` (ky-runner.ts:278-313) | `Authorization: Bearer KY_TOKEN`, the same token as the UI | Runner | Child `claude -p` processes, an outbox of unsent reports (ky-runner.ts:134-139), and a `handled` seq for dedup (247-274) | Backoff 1s to 60s with a 30s keepalive hello (ky-runner.ts:278-318). The DO queues commands in `ky_machine_inbox` until ack (machines.ts:126-160) |

## B. Flows

**B1. Chat turn.**
1. The UI sends `{type:"submit", id, input, whenBusy}`. It uses `steer` while running, else `followUp` (client.tsx:440; use-pi-session.ts:154-157). It sends no `operationId`.
2. `sockets.dispatch` runs `checkInput` (images.ts:27-46) and `chats.touch` (titling, chats.ts:72-86), then calls `handle.submit` (sockets.ts:346-363).
3. `PiHarness.enqueue` defaults operationId to `randomUUID`, submits with `requestId=operationId`, and pushes a `wake` job (agents/pi index.js:406-432, 466-475).
4. The pi-durable generation task runs. Tools are durable tasks: intent is committed first, then on replay a "safe" tool reruns and an "unsafe" one returns an interrupted error (pi-durable README:168).
5. Events stream to the UI via `#watch` (sockets.ts:242-256).

**B2. Model routing.** The `claude` provider is `vibeProxy({...})` (server.ts:74-89). `reachable()` probes `/v1/models` (vibeproxy.ts:79-101). When it is up, it uses the anthropic stream over `binding.fetch`, restricted to Messages paths (vibeproxy.ts:23, 65-74). When it is down, it uses `opencode.streamSimple` with the fallback slot. `onChange` triggers `applyMain`, which reconfigures ROOT plus every chat (server.ts:225-237). Titles use a separate `#complete` call on the titles slot with a 30s timeout (server.ts:282-319).

**B3. Machine task (Claude Code on the Mac).**
1. The model calls the `machine` tool with `run`. If no machine is named, one is chosen only when exactly one is online (machines.ts:324-325). The id is `m-${taskId}` (335). The tool is `replay: "unsafe"` (301).
2. `start` creates a feed row (kind `machine`, `queued`) and enqueues `run` (machines.ts:162-177). `#enqueue` inserts into the inbox and delivers to any OPEN socket tagged `runner:<name>` (machines.ts:97-99, 126-150).
3. The runner acks (which deletes the inbox row, machines.ts:227-229), dedups by seq, and spawns `claude -p --input-format stream-json ... --permission-mode bypassPermissions [--resume]` (ky-runner.ts:145-168, 247-274).
4. Reports flow back: `session` (231-233), `progress` every 4s (ky-runner.ts:173-222; machines.ts:235-237), then `result`.
5. `#finish` updates ky_tasks and posts `[machine ..., task ... finished...]` into the root conversation as a steer. Its operationId is `machine-report:${id}:${crypto.randomUUID()}`, so it is **not idempotent** (machines.ts:247-269).
6. Files reach the conversation through the `ky-attach` script, which PUTs `/api/files?task=` and then `attachFile` (ky-runner.ts:71-91; server.ts:215-222, 392-394).
7. `send` steers stdin or resumes by session; `stop` withdraws a queued run or enqueues `stop`. Stop is SIGINT, then SIGKILL after 5s (machines.ts:180-204; ky-runner.ts:247-274).
8. Restart: on a runner `hello`, working tasks it no longer reports are marked "Interrupted: the runner restarted" and pending commands are redelivered (machines.ts:208-225).

**B4. Subagent (cloud).**
1. The `subagent` tool (spawn/send/stop/status, unsafe; subagents.ts:186-210) commits an `Anchor` background task.
2. It creates a child conversation owned by the anchor, with extensions `[subagent, memory, machines]` removed and its own model slot (subagents.ts:255-272).
3. It creates a `Reporter` task (281) and a feed row of kind `cloud` (291-302).
4. Reporter phases:
   - `deliver` submits to the child with `requestId subagent:<id>` and waits (98-108).
   - It checkpoints the report (117-148).
   - `report` submits to main with `whenBusy steer` and `requestId subagent-report:<id>`, which **is idempotent** (153-174).

**B5. Memory.** `memory` sections render once per context, and only when `remembers` (ROOT or a chat) is set (server.ts:134-137; memory.ts:373-392). `memory_note` is unsafe; nap, recall, zoom and forget are safe (memory.ts:394-431).

**B6. Browse / exec / executor.** `browse` is a safe tool with a 90s cap (browse.ts:17-75), and it is removed from main (server.ts:231-237). Workspace tools: read/ls/find/grep/write/delete are replay-safe (workspace.ts:19). Executor: `skills` is safe, `execute` and `resume` are unsafe, and browser approvals use elicitation (executor.ts:10-19, 117-149).

**B7. Self-edit.** The PREAMBLE tells the agent to edit `~/ky-work/ky-durable` *on the user's Mac*, open a PR, deploy, and log in at the hard-coded `https://ky.yeshwanth-yk.workers.dev/login` (server.ts:54-68). Self-edit therefore always goes through a machine task.

## C. Channels to the Mac, multi-machine, single-Mac assumptions

**Two independent channels:**

| | Model channel | Task channel |
|---|---|---|
| Direction | DO → VPC binding → tunnel → `127.0.0.1:8317` | Mac → outbound WS → DO |
| Auth | `VIBEPROXY_KEY` | `KY_TOKEN` Bearer |
| Liveness | Probe every 30s (vibeproxy.ts:25-27) | OPEN socket with tag `runner:<name>` (machines.ts:97-99) and `ky_machines.seen_at` (118-124) |
| Durability | None. Calls fail over to opencode | Inbox persisted until ack. Outbox on the runner |
| Payload | Anthropic Messages only (vibeproxy.ts:23) | `run` / `stop` commands; `hello/ack/session/progress/result` reports (machines.ts:39-62) |

**How another machine could join today:**
- *Running tasks*: run `ky-runner` with a distinct `KY_MACHINE` (regex `^[a-z0-9][a-z0-9-]{0,31}$`, sockets.ts:54-64). This works now. Two catches:
  - `run` with no `machine` is refused once more than one is online (machines.ts:324-325).
  - The tool description says "the user's real computers" (machines.ts:274-287), but the PREAMBLE paths are Mac-specific.
- *Serving a model*: this needs a new `vpc_services` entry and a provider per machine. `ORIGIN`, the single `VIBEPROXY` binding, and the catalog are all hard-coded (vibeproxy.ts:21; wrangler.jsonc:28-34; server.ts:333-358).
- *Machine-local tools* (e.g. Reminders, Shortcuts): there is no command type besides `run`/`stop`, and the runner only knows how to spawn `claude` (ky-runner.ts:145-168, 247-274). This would need a new `RunnerCommand` variant and a result path.

**Single-Mac / single-user assumptions:**
- One `VIBEPROXY` binding with `ORIGIN 127.0.0.1:8317` (wrangler.jsonc:28-34; vibeproxy.ts:21).
- The catalog text says "needs: the Mac online with VibeProxy" (server.ts:347).
- The PREAMBLE hard-codes the Mac path and the workers.dev URL (server.ts:54-68).
- The DO is named `"me"` in the Worker and the runner (server.ts:393; ky-runner.ts:279).
- One `KY_TOKEN` covers the UI and every runner. A leaked runner token is full UI access (auth.ts:12-21).
- The runner defaults to `bypassPermissions` (ky-runner.ts:43-60).
- Machine reports use a random operationId, so redelivery could double-post (machines.ts:263-266).
- File attachment from tasks only exists for machine tasks (server.ts:215-222).

## D. Capabilities available (pi-durable + agents)

**pi-durable**
- **Harness / Conversation / Entry / Commit / Document / Task / Submission / Extension** concepts are listed at README:80-90. The run flow is at 94-99.
- **Submissions**:
  - `requestId` is idempotent (README:115-124).
  - Busy modes are `steer`, `followUp`, `reject` and `write` (README:293-308).
  - agents/pi wraps this as `operationId`, where "submitting the same id twice returns the same receipt" (index.d.ts:57-61).
- **Extensions** bundle tools, sections, hooks, wraps and tasks. All are selected by default, and a conversation can `configure({extensions:{remove}})` (README:128-145, 192-210). Installing the same name replaces it, and pending tasks resume once installed (README:251-259).
- **Tools**:
  - Each call is a durable task with replay `safe|unsafe`, default unsafe (harness/types.d.ts:144-161).
  - The API exposes `commit`, `memo`, `createTask`, `waitForTask` and `conversation` (harness/types.d.ts:113-139).
- **Tasks**:
  - `defineTask` with phases, `abort` and `migrate` (types.d.ts:187-210).
  - States are pending, running, waiting{on, policy}, completing and terminal (types.d.ts:425-454).
  - `ownership`/`background` options (227-237).
  - Runtime offers `commit`, `memo`, `waitForTask`, `sleep(until)` and `now` (132-185).
  - A phase must commit progress or it faults (115-119).
  - Child policies are `failFast` and `allSettled`, and abort runs bottom-up (README:448-471).
- **Docs**: `defineDoc` with scope `session|conversation|task`, history and fork behavior (README:491-511; types.d.ts:486-520).
- **Conversations**: fork, ownership by a task, and a background boundary for subagents (README:392-444).
- **Other**: compaction, events, hooks and sections with caching (README:182-188, 323-388). One process owns storage (README:529).
- **No external "resolve task" API.** Outside code can only `Session.commit`/`Conversation.commit` (types.d.ts:755-757; harness/types.d.ts:449-464) or `abortTask` (harness/types.d.ts:472-508). Tasks either wait on other tasks or poll with `runtime.sleep`.

**agents**
- **PiHarness** (agents/pi index.d.ts:150-279):
  - Sessions can be created, forked and listed, with `ROOT_SESSION = "1"` (48, 98).
  - "pi cannot wake itself": there is one `wake` Lifecycle job per session with a 30s heartbeat, a 60s sleep threshold and a 10 min wait budget (index.js:256-269, 466-513).
- **Lifecycle** (capability-runner .d.ts:67-162, 225-284):
  - `jobs.push({id, fn, time, singleflight, recoveryLoop})`; pushing the same id replaces the job.
  - Outcomes are `undefined | rescheduleAt | yield`.
  - Also provides `trackAlarmWork`, events and routes.
  - Installed with `Lifecycle.install(this).use(...)` (server.ts:195-197).
- **WebSockets** capability with hibernation tags (sockets.ts:179-207).
- **Scheduler** (scheduler .d.ts:20-210; exported as `agents/schedules`, package.json:250):
  - Supports scheduled, delayed, cron and interval schedules, idempotent by default for cron/interval.
  - It is a LifecycleCapability added via `.use`.
  - **Not used by ky today.**

## E. Assumptions and seams

1. **Durable wait vs in-memory sleep.**
   - `runtime.sleep` is an in-memory timer loop (pi-durable harness/scheduler.js:1066-1079).
   - The alarm hand-off `_longWait` only looks at generation `deferred.pollAt` / `retry.at` (agents/pi index.js:548-552; generation.js:126, 142).
   - When every task is background, the session only gets a 30s heartbeat alarm (index.js:481-499).
   - So a custom task that sleeps for hours survives only through heartbeat re-wakes and replay of its phase. This works, but it is not alarm-precise. This is why machine tasks return immediately and post a steer instead of waiting.
2. **Seam: idempotent machine reports.** Replacing the random UUID with `machine-report:${id}` would make redelivery safe (machines.ts:263-266). This mirrors `subagent-report:<id>` (subagents.ts:153-174).
3. **Seam: machine as a durable task.** A Reporter-style background task (subagents.ts:49-183) could own each machine run. `onReport` would commit into a task-scoped doc, and the task would poll it. That unifies `cloud` and `machine` in ky_tasks (tasks.ts:7).
4. **Seam: automations.** Add `Scheduler` (or a custom LifecycleCapability) via `.use` in server.ts:195-197. The callback would call `harness.submit(prompt, {operationId: \`auto:${id}:${fireTime}\`, whenBusy: "followUp"})`, which is idempotent per fire (agents/pi index.js:406-432).
5. **Seam: model providers per machine.** Generalize `vibeProxy` (vibeproxy.ts:54-60) to take `{binding, origin, name}`, and register one provider per VPC service in `createModels` (server.ts:144-151). The settings `#valid` check already requires a connected provider (settings.ts:113-120).
6. **Seam: runner protocol.** `RunnerCommand`/`RunnerReport` (machines.ts:39-62) are the only contract. A `tool` command (name, args) with a `result` keyed by call id would let machines expose local tools beyond Claude Code.
7. **Seam: auth.** A single bearer token is used everywhere (auth.ts:12-44). Per-runner tokens could be checked in `runnerFromRequest` (sockets.ts:54-64).
8. **Seam: placement.** `remembers` and `mainOnly` define what subagents lose (server.ts:134-143). New capabilities need the same per-extension decision.
9. **Assumption: one user, one DO.** Everything is keyed to `"me"`, and storage is single-owner (README:529). Sharding would mean rethinking where the `getByName` calls point.
10. **Assumption: the UI is not idempotent.** Client submits omit `operationId` (use-pi-session.ts:154-157), so a resend after a dropped socket can double-submit.
