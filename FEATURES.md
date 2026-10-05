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
| client-tools | Settings lists the tools ky can use. | src/ui/Panel.tsx:501 | local | P lists the tools ky can use |
| client-lightbox | A task's screenshot opens in the lightbox. | src/ui/Lightbox.tsx:16 | local | P shows a task's screenshot and opens it in the lightbox |

## Tools in the cloud

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| memory-note | memory_note remembers a note and memory_recall finds it. | src/memory.ts:375 | local | W features › remembers a note and recalls it |
| memory-nap | memory_nap saves a compression, memory_zoom opens it, and memory_forget drops it. | src/memory.ts:404, src/memory.ts:421, src/memory.ts:428 | local | W features › asks for a compression, saves it, opens it into its memories, and forgets it |
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
| subagent-follow-up | A message sent as a follow-up waits for the whole run before it is answered. | src/subagents.ts:84 | local | W features › waits for a whole run before answering a message sent as a follow-up |

## Machine tasks

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| task-run | A task runs on a machine, shows its session and progress, takes a follow-up, and reports its result. | src/machines.ts:167, src/machines.ts:211, runner/ky-runner.ts | local | W features › runs a task, shows its session and progress, takes a follow-up, and reports its result; H machine-run; H follow-up; P runs a task on a machine and shows its report |
| task-chat | A plain chat works end to end through the stack. | src/sockets.ts:295 | local | H chat |
| task-withdraw | A task the runner hasn't picked up is withdrawn. A picked-up task is sent a stop. | src/machines.ts:194 | local | W features › withdraws a task the runner has not picked up, and sends a stop to one it has; H stop; P stops a machine task from Activity |
| task-stop-all | Stop all in Activity stops every working task at once. | src/sockets.ts:402, src/ui/Panel.tsx:158 | local | P stops every working task at once from Activity |
| task-interrupted | A working task is marked interrupted when its runner restarts without it. | src/machines.ts:211 | local | W features › marks a working task interrupted when its runner restarts without it |
| task-files | A machine task's file is shared, and served whole or by range. | src/files.ts:100, src/files.ts:142 | local | W features › shares a machine task's file, and serves it whole and by range |
| task-screenshot | A screenshot taken through ky-attach shows on the task. | runner/ky-runner.ts:64 | local | H screenshot; P shows a task's screenshot and opens it in the lightbox |
| runner-reconnect | The runner reconnects after the socket closes and flushes its outbox after hello. | runner/ky-runner.ts:288, runner/ky-runner.ts:290, runner/ky-runner.ts:311 | local | H reconnect |

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

## Known broken: expected failures in `pnpm harness`

These scenarios check what should happen, and today they fail. They are marked `xfail`. If one starts to pass, the harness reports it and the scenario should be flipped to `pass`. All seven failed the same way on every run so far.

| id | what goes wrong | cite | check |
|---|---|---|---|
| broken-reconnect-outage | After one failed retry, the runner never reconnects. Node's WebSocket fires only `error` when a handshake fails, and the runner retries only on `close`. | runner/ky-runner.ts:311 | H reconnect-outage |
| trap-stopRace | A stop sent while the run's ack is in flight reports "Stopped before it started", and then the runner runs the task anyway. | src/machines.ts:194 | H trap-stopRace |
| trap-helloBeforeOutbox | A result that finished offline loses to the reconnect hello: the task is reported Interrupted, then done. | runner/ky-runner.ts:288 | H trap-helloBeforeOutbox |
| trap-dupExec | The ack is lost and the runner restarts: hello redelivers the run and it executes twice. | src/machines.ts:211 | H trap-dupExec |
| trap-steerIntoStop | A message sent right after stop goes to the dying claude and is lost. | src/machines.ts:194 | H trap-steerIntoStop |
| trap-stuckQueued | The result is lost on a dropping socket before any session report, and the task stays queued forever. | src/machines.ts:211 | H trap-stuckQueued |
| trap-reorder | A follow-up sent before hello is handled runs before the task's first message. | src/machines.ts:167 | H trap-reorder |

## Known gaps that have no fix yet

- When the Mac leaves or comes back, open pages aren't told. The header and Settings stay stale until a reload. The server still refuses what the stand-in can't do (`image-standin`).

## Counts

- Local features: 60.
- Live-only features: 8.
- Known broken: 7 (expected failures).
