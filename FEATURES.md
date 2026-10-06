# ky features and the checks that keep them

Each row lists one feature that works today and the check that would fail if it broke.

**Tags**
- `local` rows run in `pnpm gate`, on this Mac, against fakes at the outside boundary only.
- `live-only` rows need a real outside service. They run in `pnpm gate:live` or by hand.

**How checks are written**
- `W file › title` is a worker e2e test in `src/tests/`. It runs the real PiAgent in vitest-pool-workers.
- `H name` is a harness scenario in `test/harness/scenarios.ts`. It uses the real runner and a fake `claude` CLI.
- `P title` is a Playwright test in `test/web/ky.spec.ts`.
- `L name` is a `pnpm gate:live` check in `test/gate-live.ts`.

A cite points at the code that does the work.

## Sign-in

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| auth-gate | Pages go to the login form. The API and sockets refuse requests without the token. | src/auth.ts:43 | local | W features › sends pages to the login form and refuses the API and sockets without the token |
| auth-cookie | The right token sets an HttpOnly cookie that signs later requests in. | src/auth.ts:51 | local | W features › sets an HttpOnly cookie for the right token, which then signs requests in |
| auth-form | The form refuses a wrong token and lets the right one in. | src/auth.ts:68 | local | P sends the sign-in form to strangers, refuses a wrong token, and lets the right one in |

## Chat and turns

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| turn-stream | A run started over the socket sends a snapshot, then pi's events. | src/sockets.ts:105 | local | W sockets › sends a snapshot, then pi's events for a run started over the socket; P streams the answer to a message |
| turn-steer | A message sent while a turn runs steers that turn. | src/sockets.ts:347 | local | W features › steers a running turn with a message sent while it works; P steers a running turn with a message sent while it works |
| turn-stop | Stop ends a running turn. | src/sockets.ts:380 | local | W features › stops a running turn; P stops a running turn |
| turn-resync | Each hello carries the deploy's version, and resync sends a fresh snapshot. | src/sockets.ts:234, src/sockets.ts:386 | local | W features › serves the deploy's version, and a fresh snapshot on resync |
| turn-late-join | A client that joins mid-run gets the running state. | src/sockets.ts:234 | local | W sockets › gives a client that joins mid-run the running state |
| turn-view-fold | Folding a run's events gives the same view a late joiner gets. | src/sockets.ts:99 | local | W view › folds a run's events into the same view a late joiner gets |
| turn-hibernate | A hibernated socket keeps working after the object is evicted. | src/sockets.ts:193 | local | W sockets › keeps serving a hibernated socket after the object is evicted |
| turn-dedupe | A submit resent with the same operation id runs once and is answered `accepted:false`. | src/sockets.ts:355 | local | W sockets › dedupes a submit resent with the same operation id after a dropped socket; P sends a message again after its socket drops before the answer, and pi takes it once |
| main-free | The main chat answers while a subagent or a machine task is still working. | src/subagents.ts:84, src/machines.ts:281 | local | W background › answers the user while a subagent is still working; W background › answers the user while a machine task is still working |
| report-after-tool | A report reaches the main agent after its current tool, not after its whole run. | src/subagents.ts:84 | local | W background › hands a report to the main agent after its current tool, not after its whole run |

## Side chats and titles

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| side-chat | New side chat starts a chat. The titles model names it from its first message. | src/server.ts:220, src/chats.ts:25, src/server.ts:229 | local | W features › starts a side chat whose title the titles model rewrites from its first message; P starts a side chat, names it from its first message, and goes back to the main chat |
| title-trim | A long title is trimmed. When the titles model fails, the first line is kept. | src/titles.ts:24, src/chats.ts:19 | local | W features › trims a long title, and keeps the first line when the titles model fails; W models › trims a long title to fit; W models › gives up quietly when the model fails or there is nothing to name |

## Models, and the Mac online or away

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| mac-online | While the Mac is online, the main agent and titles run on Claude. | src/models.ts:88, src/vibeproxy.ts:50 | local | W models › puts the main agent and titles on Claude while the Mac is online; W models › runs on Claude while the Mac is online |
| mac-away | While the Mac is away, every slot uses the cloud model and Claude shows as not connected. | src/settings.ts:74 | local | W models › puts every slot on the cloud model while the Mac is away, and shows Claude as not connected |
| mac-just-left | When the Mac has just gone away, a Claude slot runs on the fallback slot's model with its key, and goes back to Claude once the Mac returns. | src/models.ts:147, src/models.ts:281 | local | W models › gives a slot on Claude the fallback slot's model when the Mac has just gone away; W models › runs on the fallback slot's model, with its key, when the Mac has just gone away, and on Claude once it is back |
| slot-store | A slot choice is stored. A provider that is not connected is refused. | src/settings.ts:113 | local | W models › stores a slot choice, and refuses a provider that is not connected |
| slot-persist | A slot's model survives restarts. A model that doesn't exist is refused. | src/settings.ts:74 | local | W features › stores a slot's model across restarts and refuses one that does not exist; P picks a slot's model in settings and keeps it after a reload, with VibeProxy off |
| main-prompt | The main prompt includes ky's repo and working copy from config. | src/server.ts:205 | local | W models › sends the main prompt with ky's repo and working copy from config |
| title-slot | Titles use Claude's small model without thinking while the Mac is online, the cloud model while it is away, and keep light thinking on the stand-in. | src/titles.ts:36, src/models.ts:281 | local | W models › asks Claude's small model without thinking while the Mac is online, and keeps the bare title; W models › asks the cloud model, still without thinking, while the Mac is away; W models › keeps its light thinking on the stand-in when the Mac has just gone away |
| image-support | The image check uses the model the slot runs on, or the fallback model while the slot's provider is away. | src/models.ts:159 | local | W models › checks the model the slot runs on; W models › checks the fallback model while the slot's provider is away |

## Images

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| image-send | Images reach the model and stay in the transcript. | src/images.ts:30 | local | W sockets › sends images to the model and keeps them in the transcript; P sends an image with a message, and refuses a fifth image |
| image-refuse | The server refuses images the model can't read, more than four images, ones that are too large, or the wrong kind. | src/sockets.ts:363, src/images.ts:30 | local | W sockets › refuses images the model can't read, or too many, too large, or the wrong kind |
| image-standin | When the stand-in can't read images, the server refuses them and the composer warns before sending. | src/sockets.ts:363, src/client.tsx:3 | local | P refuses an image the stand-in model can't read, never resends it, and warns before sending |

## Client

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| client-resend | After a reconnect, an unanswered message is sent again and pi takes it once. | src/use-pi-session.ts (onOpen, submit) | local | P sends a message again after its socket drops before the answer, and pi takes it once |
| client-resend-session | An unanswered message is resent only to its own chat. | src/use-pi-session.ts (onOpen) | local | P keeps an unanswered message for its own chat when the page switches chats |
| client-no-resend-refused | A refused submit is never resent. | src/use-pi-session.ts (error handler) | local | P refuses an image the stand-in model can't read, never resends it, and warns before sending |
| client-reload | A new deploy offers Reload, and only reloads by itself when there is no draft. | src/client.tsx:162 | local | P offers a reload when a new deploy is live and a draft would be lost |
| client-theme | The theme switch survives a reload. | src/client.tsx:63 | local | P switches the theme and keeps it after a reload |
| client-palette | The command palette opens from the keyboard and runs commands. | src/ui/CommandPalette.tsx:28 | local | P opens the command palette with the keyboard and runs a command |
| client-tools | Settings lists the tools ky can use. | src/ui/Panel.tsx:717 | local | P lists the tools ky can use |
| client-skills | The Skills tab shows each skill, and edits, reverts and archives it. | src/ui/Skills.tsx:15 | local | P shows ky's skills, edits one, reverts it and archives it |
| client-lightbox | A task's screenshot opens in the lightbox. | src/ui/Lightbox.tsx:16 | local | P shows a task's screenshot and opens it in the lightbox |

## Tools in the cloud

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| memory-note | memory_note remembers a note and memory_recall finds it. | src/memory.ts:375 | local | W features › remembers a note and recalls it |
| memory-nap | memory_nap saves a compression, memory_zoom opens it, and memory_forget drops it. | src/memory.ts:404, src/memory.ts:421, src/memory.ts:428 | local | W features › asks for a compression, saves it, opens it into its memories, and forgets it |
| skills-tools | skill_manage creates, patches and reverts a skill, keeping every version, and skill_view opens it and counts the use. | src/skills.ts:454, src/skills.ts:426 | local | W skills › creates, opens, patches and reverts a skill, keeping every version; H skills |
| skills-refuse | skill_manage refuses a bad name, a duplicate, and a patch that does not match exactly once. | src/skills.ts:96 | local | W skills › refuses a bad name, a duplicate, and a patch that does not match once |
| skills-index | Active skills are listed in the system prompt; archived ones are not. | src/skills.ts:396 | local | W skills › lists active skills in the system prompt, and drops archived ones |
| skills-review | A turn with enough tool calls is reviewed in a fork that may only call the skill tools, shown in the task feed. | src/skills.ts:404, src/skills.ts:418 | local | W skills › reviews a busy turn in a fork that may only touch skills |
| skills-panel | Skills go to the page on connect and on change; the user's edits, reverts and archives apply as "user", and history comes back on request. | src/sockets.ts:458 | local | W skills panel › sends skills on connect and on change, and takes the user's edits, history and reverts |
| workspace-files | A workspace file written by a tool outlives the object. | src/workspace.ts:101 | local | W features › writes and reads a workspace file that outlives the object |
| workspace-exec | exec runs JavaScript in the workspace. | src/workspace.ts:70 | local | W features › runs JavaScript in the workspace with exec |
| executor-tools | executor_skills, executor_execute and executor_resume reach Executor over MCP. | src/executor.ts:181 | local | W features › calls Executor over MCP |
| executor-once | A program runs once and the call answers with its result. | src/executor.ts:116 | local | W executor › runs a program once and answers with its result |
| executor-no-rerun | A program whose response was lost after it ran is never run again. | src/executor.ts:136 | local | W executor › never runs a program again when its response is lost after it ran |
| executor-expired | The call is retried once on a fresh session when Executor expired the old one. | src/executor.ts:136 | local | W executor › retries once on a fresh session when Executor expired the old one |
| executor-connect | The call is retried once when the connection can't be made, and a second failure is reported. | src/executor.ts:136 | local | W executor › retries once when the connection cannot be made, and reports a second failure |
| executor-no-401-retry | No retry when Executor refuses the token (401 or 403). | src/executor.ts:136 | local | W executor › does not retry when Executor refuses the token |
| executor-cancel | Stopping the turn cancels the call at Executor. | src/executor.ts:116 | local | W executor › cancels the call at Executor when the turn is stopped |
| browse-close-fail | The browser closes once when the page can't be opened. | src/browse.ts:212 | local | W browse › closes the browser once when the page cannot be opened |
| browse-close-stop | A browser that finishes launching after the turn was stopped is closed. | src/browse.ts:53 | local | W browse › closes a browser that finishes launching after the turn was stopped |
| browse-close-timeout | A browser that finishes launching after the launch timed out is closed. | src/browse.ts:30 | local | W browse › closes a browser that finishes launching after the launch timed out |
| browse-cap | A call whose page steps outlast the 90s cap ends, and the browser closes once. | src/browse.ts:28 | local | W browse › ends a call whose page steps outlast the 90s cap, and closes the browser once |

## Subagents

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| subagent-activity | A subagent's work shows in Activity, and its chat opens from there. | src/subagents.ts:84 | local | P shows a subagent's work in Activity and opens its chat |
| subagent-stop | A subagent's work can be stopped from the task list. | src/subagents.ts:84 | local | W features › stops a subagent's work from the task list |
| subagent-steps | Each tool a subagent uses is a step on its task, and each model response adds a turn and its cost; the task keeps when it started and finished. | src/subagents.ts:331 | local | W features › shows a subagent's tool steps, turns, and how long it took |
| subagent-follow-up | A message sent as a follow-up waits for the whole run before it is answered. | src/subagents.ts:84 | local | W features › waits for a whole run before answering a message sent as a follow-up |

## Machine tasks

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| task-run | A task runs on a machine, shows its session and steps, takes a follow-up, and reports its result with its turns and cost. | src/machines.ts:192, src/machines.ts:211, runner/runner.ts:139 | local | W features › runs a task, shows its session and steps, takes a follow-up, and reports its result and spend; H machine-run; H follow-up; P runs a task on a machine and shows its report |
| task-steps | Each tool Claude Code uses on a machine is a step on the task ("Running pnpm build"). The card shows the newest step and the elapsed time while it runs, the last few steps when opened, and its duration, turns and cost once it ends. | runner/runner.ts:281, src/tasks.ts:225, src/ui/Panel.tsx:383 | local | H steps; P shows what a machine task is doing, then how long it took and what it cost |
| topbar-background | While the open chat is idle, the topbar says what the newest background step is ("webmac: Running pnpm build"). | src/ui/task-progress.ts:52, src/ui/open-chat.ts:82 | local | P shows what a machine task is doing, then how long it took and what it cost |
| task-report-sender | A task's report goes to the conversation that sent its turn, the main chat or a side chat. A message from the task list goes to whoever sent the task's last turn. | src/machines.ts:134, src/machines.ts:381 | local | W runner-protocol › reports a task a side chat started to that side chat, not the main conversation; H side-chat-report |
| task-steer-fold | A message sent while a task works joins the running turn, and that turn's one result ends the task. The runner counts the messages Claude Code echoes (--replay-user-messages), so the task doesn't stay working. | runner/runner.ts:234, runner/runner.ts:274 | local | W runner-protocol › ends a turn that took in a message sent while it ran, with one report; H steer-folded |
| task-chat | A plain chat works end to end through the stack. | src/sockets.ts:295 | local | H chat |
| task-withdraw | A task the runner hasn't picked up is withdrawn. A picked-up task is sent a stop. | src/machines.ts:224 | local | W features › withdraws a task the runner has not picked up, and sends a stop to one it has; H stop; P stops a machine task from Activity |
| task-stop-all | Stop all in Activity stops every working task at once. | src/sockets.ts:402, src/ui/Panel.tsx:193 | local | P stops every working task at once from Activity |
| task-interrupted | A working task is marked interrupted when its runner restarts without it. | src/machines.ts:247 | local | W features › marks a working task interrupted when its runner restarts without it |
| task-files | A machine task's file is shared, and served whole or by range. | src/files.ts:100, src/files.ts:142 | local | W features › shares a machine task's file, and serves it whole and by range |
| task-screenshot | A screenshot taken through ky-attach shows on the task. | runner/ky-runner.ts:64 | local | H screenshot; P shows a task's screenshot and opens it in the lightbox |
| machine-choice | The user sets each machine on, paused or off, and a note on what it is for, from Settings or through the agent. The tool refuses a new task on a machine that isn't on, a follow-up on one that is off, and asks the agent to name a machine when more than one is on and online. | src/machines.ts:222, src/machines.ts:614, src/sockets.ts:452, src/ui/Panel.tsx:333 | local | W features › lets the user choose which machines take work, and tells the agent what each one is; P pauses a machine and notes what it is for in Settings, and the agent is refused it |
| machine-facts | The runner tells ky its OS, whether tasks drive the user's Chrome, and its git repos with their remotes (credentials removed). The agent reads them in `list` and wherever it is asked to choose. | runner/ky-runner.ts:152, src/machines.ts:550 | local | W features › lets the user choose which machines take work, and tells the agent what each one is; H machine-facts |
| machine-move | A task that has not reached a runner moves to another machine that is on. One that has run stays, since its Claude Code session is on that machine. | src/machines.ts:340 | local | W features › lets the user choose which machines take work, and tells the agent what each one is |
| task-diff | ky-diff shares a repository's changes since the branch forked, untracked files included, and the task shows them as a collapsible file list with +/- counts and Pierre diffs. | runner/diff.ts:38, src/ui/Changes.tsx:97 | local | W review › diffs from where the branch left the default branch, with new untracked files; W features › shares a task's diff, and sends the user's comments on it to the task |
| task-diff-feedback | Line comments on a task's diff go to the task as one message, with file:line and the code. | src/ui/review.ts:44, src/sockets.ts:428 | local | W review › writes every comment up as one message, in file and line order, with file:line and the code; W features › shares a task's diff, and sends the user's comments on it to the task |
| runner-reconnect | The runner reconnects after the socket closes and flushes its outbox before hello. | runner/ky-runner.ts:193, runner/runner.ts:92 | local | H reconnect |
| runner-reconnect-outage | A runner whose retry fails (503, or nothing listening) keeps retrying and reconnects. Node's WebSocket fires only `error` when a handshake fails, and the runner retries on it. | runner/ky-runner.ts:211 | local | H reconnect-outage |
| runner-stop-race | A stop sent while the run's ack is in flight stops the run, with one report and no "Stopped before it started". | src/machines.ts:224 | local | W runner-protocol › stopRace: a stop racing the ack stops the run, with one report; H trap-stopRace |
| runner-offline-result | A result that finished offline is sent before the reconnect hello, so it is reported once, as done, not Interrupted. | runner/runner.ts:92 | local | W runner-protocol › helloBeforeOutbox: a result finished offline is reported once, as done; H trap-helloBeforeOutbox |
| runner-run-once | A run whose ack was lost runs once across a runner restart: handled seqs are on disk (KY_STATE_DIR) before the ack. | runner/handled.ts:18, runner/runner.ts:139 | local | W runner-protocol › dupExec: a run whose ack was lost runs once across a runner restart; H trap-dupExec |
| runner-steer-after-stop | A message sent while a task is stopping starts a new session after the stop, resuming it. | runner/runner.ts:205 | local | W runner-protocol › steerIntoStop: a message sent while stopping starts a new session after it; H trap-steerIntoStop |
| runner-lost-reports | A task whose reports were lost with the socket ends as Interrupted instead of staying queued. | src/machines.ts:247 | local | W runner-protocol › stuckQueued: a task whose reports were lost ends instead of staying queued; H trap-stuckQueued |
| runner-order | Turns reach Claude Code in the order they were sent, even when a follow-up comes before the hello is handled. | src/machines.ts:148 | local | W runner-protocol › reorder: turns reach Claude Code in the order they were sent; H trap-reorder |
| runner-protocol-version | Every runner frame is decoded against the protocol; a malformed or outdated report closes the runner's socket, and the runner ignores a malformed command. | src/runner-protocol.ts, src/sockets.ts:316 | local | W runner-protocol › decodes runner frames: a malformed report closes the runner's socket; W runner-protocol › decodes commands: the runner ignores a run without a prompt |
| runner-turn-fence | A repeated result posts once, and a late step does not reopen the task. | src/machines.ts:299 | local | W runner-protocol › fences turns: a repeated result posts once, and a late step does not reopen the task |
| runner-stop-unsent | A task the runner never got is stopped before it starts, and never runs later. | src/machines.ts:224 | local | W runner-protocol › stops a task the runner never got before it starts |
| runner-stop-queued | A second stop also drops the turn queued behind the first. | src/machines.ts:224 | local | W runner-protocol › drops a turn queued behind a stop when it is stopped too |
| runner-keepalive-race | A keepalive hello sent before a run arrived does not end that run. | src/machines.ts:247 | local | W runner-protocol › keeps a run that a keepalive hello raced |
| runner-one-socket | One socket per machine: a second runner's hello replaces the first, which exits. | src/sockets.ts:296, runner/ky-runner.ts:197 | local | W runner-protocol › keeps one socket per machine: a second runner's hello replaces the first |

## Automations

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| automation-create | The automation tool makes a recurring automation (cron in UTC) from chat and books its schedule. | src/automations.ts:197 | local | W automations › creates an automation from chat and books its schedule |
| automation-run | A run is a background subagent task `a-<id>-<slot>` with source `automation:<id>`, on the automation's own model, and its result reaches the chat once. | src/automations.ts:391 | local | W automations › runs an automation on its own model and reports once to the chat that made it; H automation-run |
| automation-one-per-slot | A slot that fires again, during its run or after an eviction, starts no second task and posts no second report. | src/automations.ts:337, src/automations.ts:361 | local | W automations › runs one task and one report when a slot fires again during its run and after an eviction |
| automation-model | A model that is not offered is refused with the choices; an automation without one runs on the subagents slot. | src/automations.ts:487, src/automations.ts:494 | local | W automations › refuses a model that is not offered and runs a model-less automation on the subagents slot |
| automation-overlap | A slot is skipped while the automation's last run is still queued or working. | src/automations.ts:368 | local | W automations › skips a slot while the last run is still working |
| automation-pause | Pause stops the live run, books nothing more, and keeps its report out of the chat; resume books from now. | src/automations.ts:471, src/subagents.ts:207, src/machines.ts:518 | local | W automations › pause stops the live run and books nothing more; resume books from now; W automations › a one-off paused while it fires stays paused and posts no report |
| automation-update | Update saves the change and rebooks the schedule; a bad cron is refused and the old booking kept. | src/automations.ts:229 | local | W automations › update rebooks the schedule |
| automation-archive | Archive cancels the schedule; unarchive brings the automation back paused. | src/automations.ts:268, src/automations.ts:294 | local | W automations › archive cancels the schedule; unarchive brings it back paused |
| automation-recover | When the object starts, an active automation whose schedule was lost is booked again. | src/automations.ts:325 | local | W automations › books lost schedules again when the object starts |
| automation-machine | An automation with a machine runs there as a machine task, enqueued once per slot even when the slot fires twice; on a machine the user paused or turned off, the run fails and says why. | src/automations.ts:435, src/machines.ts:322 | local | W automations › a machine automation enqueues its run once when a slot fires twice; W automations › a machine automation on a machine the user paused fails its run and queues nothing; H automation-machine |
| automation-self | ky can schedule a one-off for itself; it runs once, reports, and ends done. | src/automations.ts:461, src/prompt.ts:24 | local | W automations › ky schedules a one-off for itself, which runs, reports, and ends done; W automations › a one-off whose slot already ran ends done, and resuming it is refused |
| automation-chat | Runs report to the chat that made the automation, or the one named; an archived side chat is unarchived, and a deleted one falls back to the main chat. | src/automations.ts:378 | local | W automations › reports to the side chat that made it, unarchiving it if needed |
| automation-activity | Activity lists active and paused automations with their schedule, next and last run, and Pause, Resume and Archive. | src/ui/Automations.tsx:81, src/sockets.ts:187 | local | P pauses, resumes and archives an automation from Activity |

## Live-only

These need a real outside service, so the local gate can't cover them.

| id | behaviour | cite | tag | check | why it is live-only |
|---|---|---|---|---|---|
| live-login | The deployed worker serves the login form. | src/auth.ts:68 | live-only | L login | Needs the deployed worker. |
| live-auth | The deployed worker accepts KY_TOKEN and refuses requests without it. | src/auth.ts:43 | live-only | L auth | Needs the deployed worker and the real token. |
| live-hello | A deployed socket says hello with the machine tool. | src/sockets.ts:234 | live-only | L hello | Needs the deployed object. |
| live-cloud | The OpenCode Go key answers a completion. | src/models.ts:88 | live-only | L cloud | Needs a real key. Locally the faux provider stands in and the key swap is checked as "faux-key". |
| live-vibeproxy | VibeProxy on the Mac answers through the tunnel to Claude. | src/vibeproxy.ts:50 | live-only | L vibeproxy | Needs the Mac, the tunnel and a Claude login. |
| live-browser | browse drives a real Browser Rendering page. | src/browse.ts:53 | live-only | by hand: ask ky to browse a page | Locally a CDP fake stands in for the browser. |
| live-executor | Executor runs real accounts and approvals. | src/executor.ts:181 | live-only | by hand: run executor_skills, then a program that needs approval | Locally an MCP fake stands in for Executor. |
| live-claude-cli | The runner drives the real `claude` CLI on the Mac. | runner/ky-runner.ts | live-only | by hand: start a machine task with the runner on the Mac | The harness uses test/fakes/claude.ts. |

## Known gaps that have no fix yet

- When the Mac leaves or comes back, open pages aren't told. The header and Settings stay stale until a reload. The server still refuses what the stand-in can't do (`image-standin`).

## Counts

- Local features: 102.
- Live-only features: 8.
- Known broken: none. `pnpm harness` has no expected failures.
