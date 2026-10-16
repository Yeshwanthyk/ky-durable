# Hermes-agent: proactive and background behavior (scout B)

Source pinned: `/Users/yesh/code/personal/references/hermes-agent` at commit `d23cc6b06455b8551fb6f61d3cad040a0e82f5b6` ("fix(desktop): index artifacts by transcript page"). All `file:line` refs are relative to that repo root. Scope: everything proactive except skill curation (the curator is scout A's job; this file only touches it where the review fork hands off to it).

Labels: **checked** = read in the source this session; **documented** = taken from a docstring or AGENTS.md and not re-verified in code; **inferred** = my reading across files; **not read** = named but not opened.

## Summary

1. Hermes is reactive by default; its proactivity is a stack of small, separately-gated loops: a post-turn **background review fork** that writes memory and skills, **turn-counter nudges** that trigger it, a **durable cron scheduler** with consent-gated suggestions, and **session-scoped wakeups** (`/goal`, `/loop`, `/heartbeat`) that re-enter a live session. There is no overnight "dreaming" pass; the nearest thing is the cron scheduler plus the curator.
2. The review fork is the closest analogue to ky's "dreaming": it replays the full turn snapshot on a cache-parity fork, runs under a dispatch-side tool whitelist, caps itself at 16 iterations and a token budget, defers while the local model is busy, and is skipped for cron and subagents. Its output reaches future turns through files (`MEMORY.md`/`USER.md`/skills), not through the live prompt.
3. Turn-start context is injected in two places: a frozen system-prompt snapshot of memory files (reloaded only at compaction), and per-turn ephemeral memory-provider recall stamped into the user message's API copy so the system prompt's cache prefix survives. Honcho is the user-modeling provider: async prefetch with cadence and empty-streak backoff, dialectic passes with early bail, and an injection audit log.
4. Cost discipline is consistent: cheap probes run before any model call (cron `monitor_script` hashes output and skips the agent when unchanged; `wakeAgent: false` gate; `[SILENT]` suppresses delivery; trivial-prompt gate skips recall), loops have tick caps and min intervals, and suggestions have a 5-item pending cap plus dismiss latches.
5. Gaps for ky: no scheduled consolidation across sessions, no "what should the user see tomorrow" artifact, the review is per-turn with no batching, and one suggestion source (`usage`) is declared but has no producer in this commit.

---

## 1. Post-turn background review (memory and skill nudge)

**Trigger.** After a turn finishes with a non-empty final response, not interrupted, and `skip_background_review` false, `turn_finalizer` calls `agent._spawn_background_review` if either counter fired (`agent/turn_finalizer.py:737-765`, checked). Subagents return early when `_delegate_depth > 0` (`run_agent.py:~790`, checked).

**Counters (self-resetting, not timers).**
- Memory: `_tick_memory_nudge` adds 1 per user turn and fires at `_memory_nudge_interval` (default 10, `agent/turn_context.py:718-728`, `agent/agent_init.py:1315`, config `memory.nudge_interval` at `hermes_cli/config_defaults.py:1324`, checked). Requires the memory tool to be valid and a memory store to exist. Resets on any `memory` tool call (`agent/tool_executor.py:739-740`, checked). Hydrated from prior user-turn count on resume (`agent/turn_context.py:~707-715`).
- Skill: `_iters_since_skill` increments once per model iteration while `skill_manage` is available (`agent/turn_iteration_prep.py:137-138`), adds iterations reported by agent-as-provider shims (`agent/provider_projection.py:45`), resets on any `skill_manage` call (`agent/tool_executor.py:741-742`). Fires at `skills.creation_nudge_interval` (default 10, `agent/agent_init.py:1393-1395`, checked).
- Gate-free signal: a skill write during the turn resets the counter, so a session that already curated itself is not re-prompted.

**Spawn path.** `run_agent.py:784` `_spawn_background_review` decides *when* (config `auxiliary.background_review.enabled`, default true, fail-open; defer check) and then `_spawn_background_review_now` (`run_agent.py:816`) starts a daemon thread named `bg-review`. The messages snapshot is structurally cloned at the single chokepoint (`run_agent.py:~800`, checked).

**Fork.** `agent/background_review.py`:
- Forked `AIAgent` inherits provider, model, credentials and the cached system prompt for prefix-cache parity (`build_cache_parity_fork`, `:963`; comment at `:1043-1044` cites about 26% cost cut on Sonnet 4.5, documented in code). Counters are zeroed on the fork (`:993`), `skip_memory=True` on the fork's init kwargs (`:921`).
- Different-model routing (`auxiliary.background_review.provider/model`) swaps in a digest of older turns (`_digest_history`, `:302`) because the cache is cold anyway.
- Tool whitelist is **dispatch-side only**: advertised tool list stays byte-identical for cache parity (`_review_tool_whitelist`, `:1086`). Memory tool is granted only when the trigger was the memory counter; a skill-nudge fork never gets `memory`, "so an unattended fork cannot act on the memory tool's 'consolidate now' hint" (`:1092-1094`, checked).
- Caps: `_REVIEW_MAX_ITERATIONS = 16` (`:151`); aggregate input-token budget = min(600k, 75% of the fork's context window), fallback 120k (`:158-159`, `:182-191`, checked). Budget is checked at the top of the next iteration in `agent/conversation_loop.py:110`.
- Routed to a bad provider: falls back to main model with a one-time user warning (`:~250`, documented by the code comment).

**LLM prompts (quoted).** Three variants chosen by `(review_memory, review_skills)` (`:1303-1306`):

- Memory only, `_MEMORY_REVIEW_PROMPT` (`:353-358`):
  > "Review the conversation above and consider saving to memory if appropriate." … "If nothing is worth saving, just say 'Nothing to save.' and stop."
- Skill, `_SKILL_REVIEW_PROMPT` (`:418`, `:419`):
  > "Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome."
  and near the end: "'Nothing to save.' is a real option but should NOT be the default."
- Combined, `_COMBINED_REVIEW_PROMPT` (`:504`): same, plus the memory routing block.

Routing block shared by both (`_MEMORY_ROUTING_BLOCK`, `:~340`): "TWO distinct stores — pick the right one for each fact: USER.md … who the user is … MEMORY.md … facts about the ENVIRONMENT … One fact goes to ONE store, never both" (checked). The comment cites issue #30220 where the reviewer duplicated facts into both files until both hit size limits.

Skill prompt also encodes a preference order (update the currently-loaded skill first, then an umbrella, then a support file, then a new umbrella), a read-before-write guard enforced by `skill_manage` (`:418+`), and a protected-skill list (bundled, hub-installed, external, pinned, user-owned). Pinned and user-owned skills are off-limits to the autonomous fork (checked). `_DO_NOT_CAPTURE_BLOCK` (`:393`) forbids storing environment-dependent failures, negative tool claims, transient errors and one-off narratives as skills; it is a strong anti-hoarding guardrail worth reading directly.

**Output and how it reaches future turns.**
- Writes go straight to the memory and skill stores during the fork (`tools/memory_tool.py`, `skill_manage`). The fork's own summary text is never published back into the parent transcript.
- Human-facing summary: `summarize_background_review_actions` (`:~870`) inspects only successful `memory`/`skill_manage` results, skips ones already in the prior snapshot, and prints "Memory updated"-style lines by mode (`off`/`on`/`verbose`), then `_publish_review_summary` (`:1209-1215`) prints to CLI and calls `background_review_callback` for the gateway.
- Future turns: memory files are a **frozen snapshot** at load (`tools/memory_tool_store.py:90, 134, 463-466`, checked: "Frozen load-time snapshot (NOT live state — mid-session writes don't touch it, preserving the prefix cache)"). So a review write is visible to the *next session* or to the *rebuilt prompt after compaction* (`agent/system_prompt.py:~811-830` `invalidate_system_prompt` reloads memory from disk, checked). Skill writes are picked up by the skill index on the next session.
- Usage is attributed to the parent session via `record_auxiliary_usage` (`:~380`), so review cost shows up in the parent's ledger.

**Cost controls (summary).** Off switch (config); counter thresholds; skip for cron (`cron/scheduler.py:2442`, `skip_background_review=True`, comment: "~30K tok/event"); skip for subagents; iteration cap; token budget; cancel on a new live turn (`cancel_background_review_for_live_turn`, `:~80-120`, bounded 2 s wait, foreground wins); defer while the managed local model is busy (below).

### 1a. Idle deferral (managed local runtime only)

`agent/review_idle_queue.py`: if the review would decode on the managed llama-server (`review_targets_managed_local`), it is queued instead of spawned, one slot per session, newest snapshot wins, and dispatched only after 15 s of quiet and when `/slots` reports no processing slot; items older than 30 min dispatch regardless (`:26-28`, `:~160-175`, checked). Enabled by `auxiliary.background_review.defer` (default `auto`). Explicit `/refine` never defers.

## 2. Turn-start context injection

Two channels, deliberately separated for prompt caching.

**Channel A: system prompt (frozen per session).**
- `agent/system_prompt.py:516-540` `_memory_parts` appends built-in `MEMORY.md` and `USER.md` blocks (from the frozen snapshot) and the external provider's `system_prompt_block()`. Honcho's block is a static note only: "No automatic context injection … " / "Active (context-injection mode)" (`plugins/memory/honcho/__init__.py:68-79`, checked).
- SOUL.md, guidance blocks, skills index, date/timestamp line (date is "stamped at rebuild so the prefix is byte-stable within a day", `system_prompt.py:~500-510`, checked).
- Rebuilt only on compaction or explicit invalidation (`system_prompt.py:~811`).

**Channel B: per-turn ephemeral context (user message API copy).**
- `agent/turn_context.py:862` `_memory_turn_start_and_prefetch`: calls provider `on_turn_start`, then `prefetch_all(query)` unless `is_trivial_prompt(query)`; prints a recall indicator ("recalled N memories") so the user sees the injection even if the model is silent (`agent/memory_manager.py:503-514`, checked).
- `agent/turn_context.py:93` `compose_user_api_content` appends the prefetch text and the `pre_llm_call` plugin context to the **API copy** of the current user message; the live transcript keeps the clean text. `_stamp_api_content_sidecar` (`:893`) persists the exact sent bytes so replay matches.
- `pre_llm_call` hooks (`turn_context.py:754-807`, checked) let plugins inject per-turn context the same way.
- Prefetched text is wrapped in `<memory-context>` with a system note that it is "recalled memory context, NOT new user input" (`agent/memory_manager.py:~318-333`, checked) and passes through `spill_if_oversized` so one provider cannot inflate the prefix (`:~495-500`).

**Subdirectory hints (progressive).** `agent/subdirectory_hints.py:1-8`: when a tool call navigates into a directory, AGENTS.md / CLAUDE.md / .cursorrules from it are appended to the **tool result**, de-duplicated by content digest (`:154`, `:295`). Context arrives without touching the system prompt.

**Background process notifications.** `tools/process_registry_notifications.py` renders completion and watch-match events into `[IMPORTANT: ...]` text injected into the conversation by the CLI drain loop, gateway, or TUI (checked, header). `watch_patterns` is rate-limited per session: 15 s min interval, 3-strike disable, and a lifetime cap of 8 hits before falling back to `notify_on_complete` (`tools/process_registry.py:64-88`, checked). The comment says watch patterns are "ONLY for rare one-shot signals" because each match forces a full-context turn.

## 3. Honcho (user modeling, the main long-term provider here)

Plugin: `plugins/memory/honcho/` (about 6.7k lines). Selected via `memory.provider`.

**Write path.** `sync_turn` (`__init__.py:768`) records each completed turn non-blocking, sanitizes, chunks to `message_max_chars`, skips machine-generated gateway turns and bot-authored turns unless `a2aSessions` is on. `on_session_end` flushes (`:874`). Writes are gated by `saveMessages` and by cron/flush skip (`_writes_enabled`, `:404-406`; cron/flush disables the whole plugin at `:224-228`, checked). Built-in memory writes to `target=user` are mirrored as Honcho conclusions (`on_memory_write`, `:859`, checked).

**Read path.** Two layers:
- **Base context** (representation and peer card): refreshed on `contextCadence` (default 1), fetched via `prefetch_context` in the background (`__init__.py:649-667`).
- **Dialectic supplement**: `peer.chat()` calls, up to `dialecticDepth` (1–3) passes with early bail when a pass returns "signal sufficient" (>300 chars or >100 with structure, `dialectic.py:~156-175`). Cadence `dialecticCadence` (default 1), widened by an empty-streak backoff capped at 8× (`_BACKOFF_MAX`, `dialectic.py:~30-40`). Stale threads older than 2× timeout are treated as dead (`_STALE_THREAD_MULTIPLIER`).
- Reasoning level per pass: explicit `dialecticDepthLevels`, else proportional table `(3,0)=minimal, (3,1)=base, (3,2)=low`, else base scaled by query length (+1 at ≥120 chars, +2 at ≥400, capped at `reasoningLevelCap` high) (`dialectic.py:26-35`, `:114-123`, checked).

**Prompts (quoted, `plugins/memory/honcho/dialectic.py:125-145`).**
- Pass 0, cold: "Who is this person? What are their preferences, goals, and working style? Focus on facts that would help an AI assistant be immediately useful."
- Pass 0, warm: "Given what's been discussed in this session so far, what context about this user is most relevant to the current conversation? Prioritize active context over biographical facts."
- Pass 1 (gap audit): "Given this initial assessment: … What gaps remain in your understanding that would help going forward? … grounded in evidence from recent sessions."
- Pass 2 (reconcile): "Do these assessments cohere? Reconcile any contradictions and produce a final, concise synthesis of what matters most for the current conversation."

**Timing and injection.**
- `prefetch` (`__init__.py:559-600`): trivial prompts skip; first turn waits a bounded 3 s base + 2 s dialectic budget (`_FIRST_TURN_BASE_TIMEOUT`, `_FIRST_TURN_DIALECTIC_CAP`); otherwise consumes the result queued by the previous turn. The result is injected through `compose_user_api_content` (Channel B) so the system prompt is untouched.
- `injection.sessionStart` can pin which components render on the first turn (`:100-111`, `:430-447`). `injectionFrequency`: `every-turn` or `first-turn`.
- Audit log: every prefetch outcome is logged with a reason (`cron-or-tools-mode`, `trivial-prompt`, `session-not-ready`, `fetched-but-empty`, `injected`) to `~/.honcho/injection.log` (`:458-490`, checked). The docstring says "each needs a different fix", which is a useful pattern for ky's own proactive-injection diagnostics.
- Defaults (`plugins/memory/honcho/client.py:315-326`, checked): `dialecticReasoningLevel` low, `recallMode` hybrid, `injectionFrequency` every-turn, `contextCadence` 1, `dialecticCadence` 1, `reasoningHeuristic` true, `reasoningLevelCap` high.

## 4. Other memory-provider hooks (the generic contract)

`agent/memory_provider.py`:
- `prefetch` / `queue_prefetch` (`:120`, `:125`): sync read for this turn; background warm for next turn (documented).
- `on_turn_start` (`:154`), `sync_turn` (`:133`), `on_session_end` (documented as "fires only at real session boundaries, never per-turn"), `on_session_switch` (`/resume`, `/branch`, `/reset`, compression).
- **`on_pre_compress(messages)`** (`:176`, called from `agent/memory_manager.py:731`): "Extract insights from messages about to be compressed, fed into the summary prompt." This is the one place a provider sees the transcript before it is summarized away. Checked as a contract; the checkpoint/fail-closed variant is at `memory_manager.py:731-760`.
- `on_delegation` (documented): parent-side observation of subagent results.
- Timeouts: external prefetch 8 s (`agent/memory_manager.py:32`), each provider on its own thread; a stuck call is skipped until it returns (`:457-490`, checked).
- Trivial-prompt gate shared with providers (`agent/memory_provider.py:63-80`, checked).

Other providers exist (`plugins/memory/`: byterover, holographic, mem0, openviking, retaindb, supermemory). **Not read** beyond their directory listing.

## 5. Cron (durable, out-of-session scheduling)

Files: `cron/jobs.py` (store), `cron/scheduler.py` and `scheduler_*.py` (tick loop, prompt assembly, delivery, worker), `cron/monitor.py`, `cron/notepad.py`, `cron/incidents.py`, `cron/suggestions.py`, `cron/suggestion_catalog.py`. Users: `hermes cron`, `/cron`; agents: `cronjob` tool.

**Trigger.** Gateway ticker every 60 s (`gateway/run.py:4882`, checked). Schedules: duration, "every" phrase, 5-field cron, ISO one-shot (documented, `cron/AGENTS.md`). Catch-up window = half the period, clamped 120 s–2 h (documented). `next_run_at` advances before dispatch, so a crash is at-most-once (documented; `cron/AGENTS.md`).

**Inputs.** Job prompt; optional `skills`; optional `script` whose stdout is injected as a data block; `context_from` (chain a prior job's last output, 8k truncation per `monitor.py` comment); `workdir` for AGENTS.md; per-job `notepad` KV (16 KB value, 64 KB per job, documented as "prompt-injected each run", `cron/notepad.py` header, checked).

**Cost gates, in order** (all documented in `cron/AGENTS.md` and checked where noted):
1. `monitor_script` or `monitor_url` runs first; its exact output is hashed; unchanged output suppresses the agent run entirely (`cron/monitor.py` header, checked). A changed run injects a capped unified diff.
2. Script wake gate: last stdout line `{"wakeAgent": false}` skips the LLM run (`cron/scheduler_prompt.py:24-37`, checked).
3. `no_agent=True` makes the script the whole job.
4. Inactivity watchdog: 600 s idle, not wall-clock (documented).

**Cron run prompt (checked, `cron/scheduler_prompt.py:223-240`).** Prefixed to every run:
> "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: Your final response will be automatically delivered … SILENT: If there is genuinely nothing new to report, respond with exactly "[SILENT]" (nothing else) to suppress delivery. … RECURSION: This is a run of an EXISTING scheduled job — execute the task now. NEVER create or update a cron job because of recurring or future-schedule language in the task prompt below …]"

Note the explicit guard against the job creating more jobs.

**Output and delivery.** Final response delivered to `origin` / home / explicit targets (`cron/scheduler_delivery.py`); eligible deliveries can be mirrored into the user's reply-facing conversation as labelled user turns at a turn boundary (documented, `cron/AGENTS.md`). Failures: `[CRON_FAILURE]` first-line marker; durable incidents grouped by `(job_id, error signature)` with ack and repeat-alert suppression (`cron/incidents.py`, checked header).

**Memory.** Cron runs have `skip_background_review=True` (`cron/scheduler.py:2442`, checked) and Honcho disables itself in cron context (checked). AGENTS.md says cron passes `skip_memory=True`; the code passes `skip_memory=False` (`cron/scheduler.py:2441`, checked), and `agent/agent_init.py:1323` says so explicitly. The doc is stale; the Honcho self-disable is what keeps cron away from user modeling.

### 5a. Suggestions (consent-first automations)

`cron/suggestions.py`: proposals the user accepts (creates a real job) or dismisses (latched by `dedup_key`, never re-offered). `MAX_PENDING = 5`, excess dropped with a log line (`:37`, `:113-114`, checked). Surfaced only when the user runs `/suggestions` (`hermes_cli/suggestions_cmd.py:86`, checked; no push). Sources: `catalog` (curated starters, seeded by the user, `suggestions_cmd.py:69`), `blueprint` (skill `blueprint:` blocks, `tools/blueprints.py:140`), `integration`, and `usage` (self-improvement review). **`usage` has no producer in this commit** (grep for `source="usage"`, `add_suggestion` callers: none found, checked).

Catalog example worth reading (`cron/suggestion_catalog.py`, "Important-mail monitor"): a poll every 30 min that pipes candidates through an urgency classifier (`cron/scripts/classify_items.py`) and answers `[SILENT]` when nothing clears the bar.

## 6. Session-scoped re-entry: /goal, /loop, /heartbeat

All three inject a normal user message; none mutate the system prompt or toolset (documented in each module's header and checked for goal and heartbeat).

**/goal (Ralph loop), `hermes_cli/goals.py`.**
- Standing objective; after each turn, gates run first (shell commands that must pass; a failing gate's output becomes the next prompt), then an aux-model judge returns `done | blocked | continue | wait` as JSON (`JUDGE_SYSTEM_PROMPT` at `:113`; `evaluate_after_turn` at `:1450`, checked).
- Continuation prompt (`:60-65`, checked): "[Continuing toward your standing goal] Goal: {goal}. Continue working toward this goal. Take the next concrete step. If you believe the goal is complete, state so explicitly and stop. If you are blocked and need input from the user, say so clearly and stop."
- Backstops: `DEFAULT_MAX_TURNS = 20` (`:32`); parse failures pause after 3 (`:43`); transport failures pause after 5 (`:46`); judge failures are fail-open ("continue"). A `wait` verdict parks the loop on a live background process or deadline (`:414-418`).
- Delivery: CLI puts the continuation on `_pending_input` (`hermes_cli/cli_loops_mixin.py:719-735`, checked); TUI and gateway have their own runners (`tui_gateway/prompt_turn.py:365`, `gateway/run_goals.py`).

**/loop (wakeups), `hermes_cli/loops.py`.**
- Fixed interval (min 30 s, `DEFAULT_MIN_INTERVAL_SECONDS` `:24`) or self-paced: start 60 s, double while replies are unchanged, cap 15 min, snap back on change (`:26-30`, checked).
- `DEFAULT_MAX_TICKS = 100` backstop (`:26`); `--times N`; `--until` judge.
- Wakeup prompt (`:44-53`, checked): "[/loop wakeup #{tick}] Recurring task: {prompt}. … Perform the task now against the CURRENT state (re-check files, processes, or services fresh — do not assume anything from earlier iterations still holds). … If the task is now complete … end your reply with LOOP_COMPLETE on its own line — that stops the loop."
- Gateway: idle watcher injects due ticks after restart, using routing captured at creation (`gateway/run_goals.py:377`, `gateway/slash_commands_goals.py:269`, checked header).

**/heartbeat, `hermes_cli/heartbeat.py`.**
- Min 60 s (`:19`). Fires only into an idle session with an empty input queue; "a real user message always wins" (module header, checked).
- Prompt (`:22-26`, checked): "[Heartbeat — recurring instruction, fires every {interval}] {prompt} If there is nothing meaningful to do or report for this instruction right now, reply briefly that nothing has changed and stop — do not invent work."
- `due_prompt` at `:216`.

Pattern: all three use the same "nothing to report, say so briefly" escape hatch as cron's `[SILENT]`, and all three stop on an explicit marker or cap. Heartbeat and loop state is in SessionDB `state_meta`, not in files.

## 7. Insights (not proactive)

`agent/insights.py:1-5`: `InsightsEngine(db).generate(days=30)` aggregates usage. Callers are CLI (`hermes_cli/main_agent_cmds.py:118`, `hermes_cli/cli_info_mixin.py:835`), the web analytics router (`hermes_cli/web_routers/analytics.py:129`) and `/insights` in gateway status (`gateway/slash_commands_status.py:688`). **Checked: no scheduled or post-turn caller.** Useful as a data source for a dreaming job, not as one.

## 8. Other notable pieces (lighter read)

- **Session titles** (`agent/title_generator.py`, header read): instant deterministic title, then one small-model upgrade call off the critical path; provenance `derived < llm < user` so a user-typed name is never replaced.
- **Verify-on-stop and pre_verify nudges** (`agent/turn_stop_gates.py:1-8`, `agent/verification_stop.py:160`, checked headers): when the model stops with text after code edits, a synthetic user nudge continues the turn, max 2 attempts (`max_attempts=2`, `:161`). This is a within-turn self-check, not a user-facing proactive act.
- **Side questions** (`/btw`, `agent/side_question.py`, header): answers about the conversation on a cache-parity fork with tools denied, no synthetic turn.
- **Context compaction** (`agent/context_compressor.py`, `agent/conversation_compression.py`): summary generation on threshold, with `on_pre_compress` provider hook. **Not read in depth.**
- **Outbound webhooks** (`agent/outbound_webhooks.py`, header): lifecycle events POSTed to external URLs, fire-and-forget, HMAC-signed. Inbound subscriptions in `hermes_cli/webhook.py` (header). **Gateway webhook adapter not read.**
- **Bot relay** (`tools/bot_relay.py`, header): agents on different gateways message each other via file-based outbox and a reply waiter, so a reply wakes the sender. Desktop-only path.
- **Kanban dispatcher** (`cron/AGENTS.md`, documented): a 60 s loop inside the gateway that claims ready tasks and spawns assigned profiles; auto-blocks after 2 failures. Not read in code.
- **`/learn`** (`agent/learn_prompt.py`): a one-shot prompt that turns a user-described source into a skill. On demand, not proactive.
- **Learning graph** (`agent/learning_graph.py`, header): a desktop visualization of skills and memory chunks with lexical links. Read-only.
- **Turn summary** (`agent/turn_summary.py`, header): display-only per-turn tally line.

## Ideas worth stealing for ky

1. **Two-store routing rule in the review prompt.** Put "who the user is" and "facts about the environment" in separate stores, and make "one fact goes to ONE store, never both" an explicit rule with the failure it prevents. Cheap, and it fixes a real drift mode (`background_review.py:~340`).
2. **Dispatch-side tool whitelist for unattended forks.** Keep the advertised tool list identical to the parent's for cache parity and enforce the restriction at dispatch. Gate destructive tools on the trigger that fired (`:1086-1094`).
3. **Self-resetting counters over timers.** Count user turns and tool iterations since the last write of the relevant kind, and reset on that write. A session that already did the work is not re-prompted (`turn_context.py:718`, `tool_executor.py:739-742`).
4. **Snapshot-then-ephemeral injection.** Keep the system prompt frozen per session and put per-turn recall in the API copy of the user message, stamped as a sidecar so replay is exact (`turn_context.py:93`, `:893`). Reload the frozen snapshot only at compaction (`system_prompt.py:~811`).
5. **Injection audit with reasons.** Log every "no injection" outcome with a named reason (`honcho/__init__.py:458-490`). Users can then tell "not fetched" from "fetched but empty" from "suppressed by config".
6. **Cheap probe before the model.** A monitor source runs first, its output is hashed, and the agent is skipped when nothing changed (`cron/monitor.py`). Also the wake-gate line `{"wakeAgent": false}` (`cron/scheduler_prompt.py:24-37`). This is the cost story for any always-on watcher.
7. **A silent token with a contract.** `[SILENT]` means nothing to report, with rules: never combined with content, never translated (`scheduler_prompt.py:223-240`). Use the same pattern for overnight jobs that have nothing to say.
8. **Consent-first suggestions.** Proposals sit in a capped list (`MAX_PENDING = 5`), are latched on dismiss by `dedup_key`, and nothing auto-creates (`cron/suggestions.py`). Good template for ky's proactive surfacing.
9. **Bounded deferral of background work.** A settle window (15 s quiet) plus a max age (30 min) so deferred work still runs (`review_idle_queue.py:26-28`). Coalesce per session, newest wins.
10. **Recall indicator.** Print "recalled N memories" in the UI even when the model is silent (`memory_manager.py:503-514`). Makes proactive context visible.
11. **Honcho's cadence and backoff.** Separate cadences for base context and dialectic, empty-streak backoff capped at 8×, early bail on signal-sufficient passes (`dialectic.py:26-40`, `:146-175`). Good for any periodic LLM-backed profile refresh.
12. **Review prompt guardrails.** The "do NOT capture" block (`background_review.py:393`) lists the failure modes a self-improving agent falls into: env-dependent errors, negative tool claims, transient errors, one-off narratives, unresolved dead ends. Worth lifting almost verbatim into ky's dreaming prompt.
13. **Read-before-write for autonomous edits.** The review must re-read a skill before patching it, and the write is refused otherwise (`_SKILL_REVIEW_PROMPT`, skill_manage). Prevents stale-base overwrites in unattended runs.
14. **Staged proposals for destructive ops when unattended.** A delete from the review fork is staged for approval rather than applied or silently dropped (`tools/memory_tool.py` `proposal_staged`, `:~195`).
15. **Judge with backstops.** Goal loop: gates before judge, fail-open judge, separate parse-failure and transport-failure budgets, hard turn cap (`goals.py:32-46`). Reusable for any "keep going until done" loop in ky.
16. **Heartbeat only into idle sessions.** A real user message always wins (`heartbeat.py` header). Clean rule for any background re-entry into a live chat.

## Gaps (relative to "dreaming" and deep proactivity)

1. **No overnight or cross-session synthesis.** Nothing in this commit runs on a schedule to consolidate many sessions into a daily digest or a set of open threads. Grep for `dream`, `overnight`, `nightly`, `daily_summary` in `agent cron hermes_cli tools gateway plugins/memory` returned no such mechanism (checked). The closest pieces are the per-turn review and the cron-run briefing example in the suggestion catalog.
2. **Review is per-turn, not per-session or per-day.** Each turn can spawn a fork; there is no batching across turns, no end-of-session pass, and `on_session_end` for built-in memory does not run a review. Honcho's `on_session_end` flushes only (`honcho/__init__.py:874`).
3. **No "what matters now" artifact.** Proactivity surfaces as chat messages (review summary, cron delivery, loop ticks). There is no persistent ranked inbox that the user opens; suggestions are pulled, not pushed (`suggestions_cmd.py`).
4. **One suggestion source is dead.** `usage` is in `VALID_SOURCES` (`cron/suggestions.py:39`) with no producer (checked). The intent is clear (self-improvement review proposes automations) but it is not wired.
5. **Honcho is the only user-model writer, and it is an external service.** Local ky would need its own equivalent. Hermes has no local user-model store beyond USER.md and the dialectic answers.
6. **Insights are on-demand only.** The data exists (`agent/insights.py`) but nothing consumes it proactively.
7. **Nudges are count-based, not signal-based.** The 10-turn and 10-iteration thresholds fire regardless of content; the prompt does the filtering. A cheap heuristic pre-filter (corrections seen, new tool combos) before spending a fork is absent.
8. **Documentation drift.** `cron/AGENTS.md` says cron passes `skip_memory=True`; the code says `False` (`cron/scheduler.py:2441`). The outcome is the same for Honcho, but the doc is wrong for any new provider that does not self-disable.
9. **Not read.** Context compression internals, gateway webhook adapter, kanban dispatcher code, other memory plugins (mem0, holographic, hindsight-style ones), and the full cron scheduler tick path. Any claim about those is absent or documented-only.

## Limits

- Scope is grep-led plus reading the modules named above. Some files were read only by header and marked as such.
- Line numbers are from the pinned commit; they will drift.
- I did not run any of the code paths. Behavior claims marked "checked" come from reading the source, not from a run.
