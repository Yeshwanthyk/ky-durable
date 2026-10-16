# Hermes-agent curator: how it runs, what it reads, what it changes

Scope: scout A of the proactivity research. Source: `/Users/yesh/code/personal/references/hermes-agent` at commit `d23cc6b0`. All paths below are relative to that repo unless absolute. Read-only; no tests were run.

Labels: **[checked]** = read in the code at the cited line. **[documented]** = stated only in docs or prompt prose, not verified against code. **[inferred]** = my reading across files.

## Five-line summary

1. **Trigger:** no daemon. An inactivity check runs on CLI startup (`idle=inf`), on the `hermes serve`/Desktop hourly timer (idle measured from last chat activity), and is skipped when a messaging gateway owns the profile. It fires only if `interval_hours` (default 168) has elapsed since `last_run_at` and idle ≥ `min_idle_hours` (2). First observation only seeds the clock. [checked]
2. **Inputs:** deterministic pass reads only `.usage.json` timestamps and counters (`last_activity_at`, `use_count`, `created_at`) plus the cron-reference set; no transcripts. The LLM pass sees a metadata candidate list and reads skill files through `skill_view`; it never sees conversations. [checked]
3. **Changes:** deterministic pass moves idle skills `active → stale → archived` (archive = `mv` into `.archive/`) and never deletes; always on when enabled. LLM pass (opt-in, `consolidate: false` by default) merges/patches/creates umbrella skills, demotes content to `references/`, and archives with a mandatory `absorbed_into` target. Pinned, bundled, hub, external-dir and cron-referenced skills are protected in code, not only in prompt. [checked]
4. **Safety is layered:** tar.gz snapshot before any consolidation run (keep 2); per-mutation JSONL ledger with content-addressed blobs and single-entry rollback that fails closed; rollback takes a pre-rollback snapshot; background fork has no terminal tool, read-before-write marks, and origin-tagged write guards; a dry-run banner. Undo is always possible except `purge`, which is explicit only. [checked]
5. **Results reach future turns indirectly:** the curator changes files on disk. The next session's system prompt rebuilds a `## Skills` index (name + truncated description) from a file-signature-validated snapshot; the agent loads full content with `skill_view`. The curator itself writes no memory and injects nothing into conversations; its summary only prints to the console or to `hermes curator status`. [checked]

---

## 1. Triggers

**Scheduled-by-inactivity, not cron.** Core docstring: "Inactivity-triggered (no cron daemon)" (`agent/curator.py:1-5`). [checked]

Call sites (the only three in non-test code):
- CLI startup: `hermes_cli/cli_tui_runtime_mixin.py:350-357`, `_run_startup_maintenance` runs off the main thread with `idle_for_seconds=float("inf")`. [checked]
- Serve/Desktop timer: `hermes_cli/web_server_sessions.py:268-308` (`_skill_maintenance_idle_for`, `_maybe_run_skill_maintenance`) and the hourly loop at `:311-330` (first poll after 90 s). Idle = time since the most recent chat activity across the profile's sessions, returns `None` (skip) if any session is `running`. [checked]
- Gateway owns the chore: `_maybe_run_skill_maintenance` returns early if `_check_gateway_running` (`web_server_sessions.py:~284-289`). [checked]

Gates inside `maybe_run_curator` (`agent/curator.py:1198-1212`):
- `should_run_now()` (`:160-181`): enabled, not paused, `(now - last_run_at) >= interval_hours`. If `last_run_at` is missing, it seeds it to now and returns False. [checked]
- `idle_for_seconds >= min_idle_hours * 3600` when a measurement is given. [checked]
- `_claim_run()` (`:1169-1190`): O_EXCL lock file at `skills/.locks/curator-run`, takeover after 3600 s. Prevents two processes both pruning. [checked]

Manual: `hermes curator run` (`hermes_cli/curator.py:~140-180`) bypasses `should_run_now` and idle gating; `--dry-run`, `--consolidate`, `--background`. Also `pause`/`resume` (`set_paused`), and `hermes curator backup`. [checked]

Config defaults: `DEFAULT_INTERVAL_HOURS = 24*7`, `DEFAULT_MIN_IDLE_HOURS = 2`, `DEFAULT_STALE_AFTER_DAYS = 14`, `DEFAULT_ARCHIVE_AFTER_DAYS = 30`, `DEFAULT_CONSOLIDATE = False` (`agent/curator.py:31-35`). `_bounded_count` floors values < 1 to the default with a warning, explicitly because a 0 would mass-archive on the next tick (`:~120-140`). [checked]

Docs claim the first run is deferred one interval so a fresh install is not mutated immediately (`website/docs/user-guide/features/curator.md`, "First-run behavior"). [documented, consistent with `should_run_now`]

## 2. Inputs and scoring

### Telemetry (`tools/skill_usage.py`, sidecar `skills/.usage.json`)

Per-skill record keys (`_empty_record`, `skill_usage.py` ~`:235-245`): `created_by`, `use_count`, `view_count`, `last_used_at`, `last_viewed_at`, `patch_count`, `last_patched_at`, `created_at`, `state`, `pinned`, `archived_at`, `first_seen_at`. Plus `patch_generation` / `last_reused_patch_generation`, which track whether a skill was reused after a patch. [checked]

Writers:
- `skills_tool.py:743-747`: every successful `skill_view` calls `bump_view` **and** `bump_use`. So viewing = use. The comment says so explicitly. [checked]
- `agent/skill_commands.py:355-356` and `cron/scheduler_prompt.py:201` also call `bump_use`. [checked]
- `skill_manager_tool.py:748-759`: `record_created` (sets `created_by`) and `bump_patch`. [checked]

Activity definition: `latest_activity_at` = max of `last_used_at`, `last_viewed_at`, `last_patched_at`; `created_at` is excluded on purpose (`skill_usage.py` ~`:215-222`). [checked]

### Provenance (who the curator may touch)

`is_curation_eligible` and `_is_curator_managed_record` (`skill_usage.py:278-296`): managed iff `created_by == "agent"` (or legacy `agent_created: true`). Only the background review fork writes `created_by: agent` (`skill_manager_tool.py:756`, `record_created(..., agent_created=is_background_review())`). Foreground `skill_manage(create)` writes `created_by: learn`, which is explicitly *not* opt-in (`skill_usage.py:522-543`). [checked]

Consequence: a user's hand-written skill is invisible to the curator unless they run `hermes curator adopt` (`hermes_cli/curator.py`, `_cmd_adopt`). Provenance is a user declaration, not inferred from activity. Docstring says so: "provenance cannot be inferred from telemetry (a high patch count proves the agent MAINTAINS a skill, not that it AUTHORED it)" (`hermes_cli/curator.py:~285-290`). [checked]

Protected (never eligible, `skill_usage.py:278-288`): protected built-ins (`PROTECTED_BUILTIN_SKILLS`, currently empty set at `:~45`), hub-installed, skills under `skills.external_dirs`. Bundled built-ins only with `curator.prune_builtins`. [checked]

### Deterministic scoring (`apply_automatic_transitions`, `agent/curator.py:209-263`)

No score; a threshold on one timestamp:
- `anchor = last_activity_at` → fallback `created_at` → fallback `now`. [checked]
- Pinned or cron-referenced skills are skipped entirely (`:216-224`). `_cron_referenced_skills` reads `cron.jobs.referenced_skill_names` and includes paused jobs (`:184-196`). [checked]
- First sight with no persisted record: seed `first_seen_at` and defer (`:226-230`). Bundled skills with no activity get their clock re-anchored once (`:232-237`). [checked]
- `use_count == 0 and anchor > stale_cutoff`: never archive a young never-used skill; reactivate if it was stale (`:245-252`). [checked]
- `anchor <= archive_cutoff` → archive; `anchor <= stale_cutoff` and active → stale; `anchor > stale_cutoff` and stale → active (`:254-262`). [checked]

So: recency only, frequency only as a grace guard. A skill used 500 times and then idle for 30 days is archived the same way as one used once.

### LLM pass inputs (`_render_candidate_list`, `agent/curator.py:832-852`)

One line per candidate, built from `curated_report()`:
`name provenance state pinned cron activity use view patches last_activity`. No skill body, no transcript, no failure data. [checked]

Candidates exclude bundled built-ins even under `prune_builtins`, and `skills.disabled` names, because `skill_view` would refuse them and the fork would burn its budget (`:~836-845`). [checked]

## 3. What changes, and the LLM prompts

### Deterministic pass

- `_u.set_state` (active/stale/archived) and `archive_skill` (`skill_usage.py:626-653`): moves the whole dir to `skills/.archive/<name>` (flattened by name, timestamp suffix on collision), `os.utime` resets mtime so TTL aging starts now, toggles suppression for bundled skills, and writes a ledger entry with actor `curator`. [checked]
- Nothing is deleted here. `purge` (`hermes_cli/curator.py` `_cmd_purge`) is explicit and gated by `archive_ttl_days` (default 0 = never). [checked]

### LLM pass (opt-in)

Entry: `run_curator_review` → `_consolidation_pass` → `_run_llm_review` (`agent/curator.py:915`, `:881`, `:1085`). It forks an `AIAgent` with `enabled_toolsets=["skills"]` (no terminal, `:1116`), `max_iterations=9999` (`:1118`), `skip_memory=True`, `skip_context_files=True`, nudges disabled, `_memory_write_origin = "background_review"`. [checked]

Prompt: `CURATOR_REVIEW_PROMPT` (`agent/curator.py:290-~450`). Key text, quoted:

- Goal: `"The goal of the skill collection is a LIBRARY OF CLASS-LEVEL INSTRUCTIONS AND EXPERIENTIAL KNOWLEDGE. A collection of hundreds of narrow skills where each one captures one session's specific bug is a FAILURE of the library"` [checked]
- Distillation over moving: `"Consolidation means DISTILLING: the absorbed content becomes rules (imperative + one clause of why), the same lesson stated twice becomes one rule, and incident narration, PR/issue numbers, dates and quoted chatter are dropped"` and `"Moving a file unchanged under references/ is filing, not consolidating."` [checked]
- Size budget: `"A SKILL.md body over ~24k chars is a consolidation target on its own: skill_view loads all of it into context for the rest of the session"` (`:310-313`). [checked]
- Usage counters not evidence: `"DO NOT use usage counters as a reason to skip consolidation... 'use=0' is ALSO not a reason to PRUNE a skill."` [checked]
- Ban on absorbing without a forwarding target: `"Deletes without a verified forwarding target are refused... pruning with no absorption target is the deterministic staleness pass's job, never this one's."` [checked]
- Quota pressure: `"Expected output: real umbrella-ification. Process every obvious cluster. If you end the pass with fewer than 10 archives, you stopped too early"` (`:443-445`). [checked] — see weakness W2.
- Package integrity: do not flatten `SKILL.md` into another skill's `references/` when support files or relative links exist; re-home every file or archive the whole package (`:~390-410`). [checked]
- Read-before-write enforced in code, not only in prose (`skill_manager_guards.py:220-232`). [checked]
- Required output: a fenced ```yaml block with `consolidations: [{from, into, reason}]` and `prunings: [{name, reason}]`, every archived skill in exactly one list (`:~447-465`). [checked]

Dry-run: `CURATOR_DRY_RUN_BANNER` (`:266-288`) is prepended. It forbids `patch/create/delete/write_file/remove_file` and asks the fork to describe what it would do. Dry-run also skips the auto transitions and does not bump `last_run_at` (`:955-962`). [checked] Compliance is only prompt-level: the banner asks the fork to report any accidental mutation so a reviewer can revert it (`:~283`), and I found no code path that blocks `skill_manage` writes when `dry_run` is set. [checked, inferred weakness]

Classification of the outcome (`_reconcile_classification`, `agent/curator.py:582-640`): every removed skill is bucketed into consolidated vs pruned using a precedence chain: (1) `absorbed_into` declared on the delete call, (2) model YAML block, (3) substring audit of tool-call arguments, (4) fallback = pruned. Used for REPORT.md, the rename map, and cron rewrites. [checked]

## 4. Safety

| Guard | Where | Checked? |
|---|---|---|
| Archive, never delete (`archive_skill` moves dir) | `skill_usage.py:626-653`; prompt hard rule 2 | checked |
| Pinned exempt from auto transitions and LLM pass; `skill_manage delete` refuses pinned, patch allowed | `agent/curator.py:216`; `skill_manager_guards.py:143-161`, `:164-197` | checked |
| Essential built-ins can never be deleted | `_pinned_guard` (`skill_manager_guards.py:143-161`) | checked |
| Bundled, hub, external-dir, protected built-in refused for background writes | `_background_review_write_guard` (`skill_manager_guards.py:164-218`) | checked |
| User-owned (no `created_by: agent`) refused for background writes, fail closed on unreadable record | same, `:~196-218` | checked |
| Consolidation delete must name an existing umbrella (`absorbed_into`), otherwise refused, fail-closed | `_curator_consolidation_delete_guard` (`:241-261`) | checked |
| Read-before-write marks shared across copied contexts | `skill_manager_guards.py:35-75`; `agent/curator.py:1138-1148` | checked |
| No shell tool in the fork, so no untracked `mv`/`rm`; all writes go through ledgered `skill_manage` | `agent/curator.py:1113-1116` comment | checked |
| `_validate_delete_target`: refuses symlink, skills root itself, paths outside roots | `skill_manager_guards.py:105-130` | checked |
| Snapshot before consolidation runs only; `keep` default 2 | `agent/curator.py:935-944`; `agent/curator_backup.py:41, 153-200` | checked |
| Snapshot excludes `.archive/`, `.hub/`, `.git/`, `.locks/`, ledger, backups; rollback never rewinds them | `agent/curator_backup.py:14-41` (commentary cites #91449, #107539, #96962) | checked |
| Rollback takes a pre-rollback snapshot first | `curator_backup.rollback` (`:406`); docs | checked (fn), documented (flow) |
| Per-mutation ledger, content-addressed blobs, `rollback_entry` fails closed if safety capture fails | `tools/skill_ledger.py` header, `:569`, `:501`, `:523` | checked (header, fn names); the full body was not read |
| Same-process and cross-process run claim; no double pass | `_claim_run` `agent/curator.py:1169-1190` | checked |
| Config values < 1 cannot mass-archive | `_bounded_count` `agent/curator.py:~120-140` | checked |
| Cron jobs' skill refs rewritten to umbrella on consolidation, dropped on prune; backed up in snapshot | `_rewrite_cron_refs` `agent/curator.py:~680-697`; `curator_backup.py:~60-80` | checked |
| Fork never touches main session prompt cache; forks on aux model | `agent/curator.py:1-5` docstring, `:1085` | checked |

Reversibility: deterministic archive → `hermes curator restore <name>`. Consolidation → `hermes curator rollback` (whole tree) or `rollback <entry-id>` (single mutation). `purge` is the only permanent deletion and requires a TTL and confirmation. [checked against CLI code]

## 5. How results flow back into future turns

The curator writes files; nothing curator-specific is injected into a conversation.

1. **Skill index in the system prompt.** `build_skills_system_prompt` renders a `## Skills` block with `- name: description` per skill (`agent/prompt_builder.py:1378-1442`). Descriptions are cut to 60 chars including `...` (`agent/skill_utils.py:761-773`). The prompt text itself says "long descriptions are truncated to 57 chars", which matches 57 chars + "...". [checked]
2. **Snapshot validity.** The index is cached on disk in `.skills_prompt_snapshot.json`, validated by a file-signature manifest of every SKILL.md and DESCRIPTION.md (`prompt_builder.py:1163-1211`). An archive move changes the manifest, so the snapshot rebuilds on the next session without an explicit cache clear. [checked] The curator's own archive path does not call `clear_skills_system_prompt_cache` (grep: only `skill_manager_tool`, `skills_hub`, `web_routers/skills`, `conversation_loop`, `learning_mutations` call it). [checked]
3. **Full content.** The agent is instructed to `skill_view(name)` anything relevant (`prompt_builder.py:~1420-1430`). `skill_view` is also the only signal that bumps `use_count`, so a loaded skill stays "active". [checked]
4. **Archived skills leave the index** (archived dirs go to `.archive/`, so they are not scanned). A restore brings them back. [checked, inferred from `skill_usage.py:704` `curated_report` scope and `_iter_skill_mds`]
5. **User-visible only.** `on_summary` prints to console; `last_run_summary` is shown once after `hermes update` if multi-line (rename map), and in `hermes curator status`. [checked, `hermes_cli/update_cmd_maint.py:207-236`]
6. **Cron jobs** reference skills by name; consolidation rewrites those refs, so scheduled jobs keep loading content. [checked]

Separately, the *input* to skill creation/patching is the per-session background review fork (`agent/background_review.py`, `_SKILL_REVIEW_PROMPT` at `:418`), spawned after a turn when `_iters_since_skill >= _skill_nudge_interval` (default 10, `agent/agent_init.py:1393`; trigger `agent/turn_finalizer.py:740-765`). That fork reads the conversation snapshot. It is the transcript-to-skill path. The curator is the separate maintenance path over the results. [checked]

## 6. Ideas to steal, and weaknesses

### Ideas worth stealing (for ky dreaming and proactivity)

1. **Inactivity-gated scheduling with no daemon.** Idle-measured-from-chat-activity, not socket time; a claim lock file; first run deferred one interval so the first install is not surprised. `agent/curator.py:160-181, 1169-1212`; `hermes_cli/web_server_sessions.py:268-308`.
2. **Two tiers: deterministic lifecycle always on, LLM consolidation opt-in.** The cheap, reversible pass runs every time; the expensive, opinionated pass is explicit. `DEFAULT_CONSOLIDATE = False`, `agent/curator.py:35`.
3. **Explicit provenance opt-in.** Curation applies only to items marked as machine-authored at creation. The user adopts others explicitly. Avoids the failure mode of touching hand-written content. `skill_usage.py:278-296`, `hermes_cli/curator.py` `_cmd_adopt`.
4. **Enforce policy in code, not in prompt.** Background-origin ContextVar, guards that refuse pinned/bundled/user-owned writes, read-before-write marks, no shell tool in the fork. The prompt describes the policy; the guards enforce it. `skill_manager_guards.py`.
5. **Declared intent at the mutation.** `absorbed_into` on `delete` is authoritative; prose summaries are fallbacks. Makes the report and cron rewrites deterministic. `agent/curator.py:582-640`.
6. **Ledger + content-addressed blobs + fail-closed single-entry rollback.** Better than a whole-tree snapshot for "undo just this." `tools/skill_ledger.py`.
7. **Prompt vocabulary worth reusing.** "class-level umbrella", "distill, don't move", "usage counters are not evidence", "package integrity: never flatten SKILL.md away from its support files". The 24k-char SKILL.md budget is a concrete guard against context bloat.
8. **Report artifacts.** Each run writes `run.json` and `REPORT.md` with counts, transitions, and rename map under `logs/curator/<ts>/`. `agent/curator.py:699-829`.
9. **Tests are a checklist.** About 130 test functions (`def test_` count, not run) across `tests/agent/test_curator*.py`, `tests/hermes_cli/test_curator_*.py`, `tests/tools/test_skill_ledger.py`, `tests/tools/test_skill_usage.py` (counted by grep, not run). Good coverage map for regression.

### Weaknesses and risks

W1. **Scoring is recency-only.** The deterministic archive uses one timestamp (`last_activity_at`). It ignores how often or how well a skill worked, and it ignores whether the skill is *needed on demand*. A rarely needed but critical runbook gets archived after 30 idle days unless pinned. [checked] Mitigation is pinning, and cron-referenced skills are protected, but nothing else. For proactivity, "idle" and "unneeded" are different questions.

W2. **Quota pressure in the prompt.** "If you end the pass with fewer than 10 archives, you stopped too early" (`agent/curator.py:443-445`) pushes the model to find archives rather than keep. The same prompt says "keep is legitimate". The two conflict, and the quota can override judgment. [checked, inferred impact]

W3. **No transcript or outcome signal in the curator.** The LLM pass judges overlap from skill text alone. It cannot know whether a skill helped, failed, or was ignored. Usage counts are the only behavioral signal, and `skill_view` inflates them (view = use), so `use_count` is not a success metric. [checked]

W4. **Dry-run is prompt-only.** The banner asks the fork not to mutate. No code path blocks `skill_manage` writes in dry-run. The mitigation is that the fork has no terminal and the ledger records any write. [checked]

W5. **Cost and wall clock.** Up to 9999 iterations, typically 50–100 API calls, minutes per run (docs; `max_iterations=9999` at `agent/curator.py:1118`). Opt-in, but when on, it is expensive. I did not verify how cancellation behaves mid-pass. [documented, partly checked]

W6. **Heuristic-heavy classification.** Five-way precedence chain with substring matching on tool-call args (`_classify_removed_skills`, `agent/curator.py:~540-580`) to explain outcomes after the fact. Reports can be wrong; the code acknowledges a "hallucinated umbrella" case. Fine for reporting, bad as a source of truth. [checked]

W7. **Single-user, single-home assumptions.** Per-profile home overrides, `_claim_run` with a one-hour stale takeover, and a `serve` vs gateway split. Multiple serve processes for one profile can still race (docs say so). [documented]

W8. **Index can drift from reality between sessions.** Archived skills vanish from the index only at the next prompt build. Skills created mid-session are not indexed until the snapshot rebuilds. Acceptable, but it is a freshness lag to design around. [inferred]

W9. **Heavy on-disk machinery.** Snapshots, ledger, blobs, reports, claim lock, suppression list, usage sidecar, cron backup. Many bugs were fixed in these layers (issues cited in comments: #91449, #107539, #96962, #67140, #29912). Signals the surface is hard to get right; a smaller first version would not need all of it. [inferred from code comments]

## Mapping to the ky goal (context at the right time)

- Hermes' answer to "right context at the right time" is mostly a cheap always-on **catalog** (name + 60-char description in the system prompt) plus **lazy load** (`skill_view`). The curator's job is to keep that catalog small and sharp, not to decide what to load. [checked]
- The curator does not do retrieval or per-turn relevance. Nothing in this path ranks skills against the current message. If ky needs deep proactivity, the curator pattern gives lifecycle hygiene but not relevance. That would need a separate signal, such as recency-weighted reuse per topic, or a retrieval step on the user's message. [inferred]
- Reusable hook: `use_count` bumps on `skill_view`, and `patch_generation` tracks reuse after patch (`skill_usage.py:497-508`). That is a cheap feedback edge from "loaded" to "was it useful."

## Open questions and limits

- Did not read `tools/skill_ledger.py` beyond the header, `rollback_entry`, `record_mutation`, `capture_before`, and `gc_blobs` signatures. The blob format and GC body were not verified.
- Did not read `agent/curator_backup.py` `rollback` body (`:406+`) or `_prune_old` body.
- Did not run the test suite or any curator command. All "checked" labels mean read-only inspection of the source at `d23cc6b0`.
- Did not check how `AIAgent` consumes the `skill_view` result's `bump_use` under cron (`cron/scheduler_prompt.py:201`) beyond the call site.
- The docs mention a `/curator` slash command in gateways; not verified in code.
- Could not confirm whether `prune_builtins` path is exercised by any test beyond the names listed.
