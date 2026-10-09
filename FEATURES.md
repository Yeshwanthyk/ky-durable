# ky features and the checks that keep them

Each row lists one feature that works today and the check that would fail if it broke.

**Tags**
- `local` rows run in `pnpm gate`, on this Mac, against fakes at the outside boundary only.
- `live-only` rows need a real outside service. They run in `pnpm gate:live` or by hand.

**How checks are written**
- `W file › title` is a worker e2e test in `src/tests/`. It runs the real PiAgent in vitest-pool-workers.
- `H name` is a harness scenario in `test/harness/scenarios.ts`. It uses the real runner and fake `claude` and `codex` CLIs.
- `N file › title` is a Node test in `test/node/`, on the build's config.
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
| turn-stream | A run started over the socket sends a snapshot, then pi's events. | src/sockets.ts:93 | local | W sockets › sends a snapshot, then pi's events for a run started over the socket; P streams the answer to a message |
| turn-steer | A message sent while a turn runs steers that turn. | src/sockets.ts:351 | local | W features › steers a running turn with a message sent while it works; P steers a running turn with a message sent while it works |
| turn-stop | Stop ends a running turn. | src/sockets.ts:381 | local | W features › stops a running turn; P stops a running turn |
| turn-resync | Each hello carries the deploy's version, and resync sends a fresh snapshot. | src/sockets.ts:234, src/sockets.ts:387 | local | W features › serves the deploy's version, and a fresh snapshot on resync |
| turn-late-join | A client that joins mid-run gets the running state. | src/sockets.ts:234 | local | W sockets › gives a client that joins mid-run the running state |
| turn-view-fold | Folding a run's events gives the same view a late joiner gets. | src/sockets.ts:87 | local | W view › folds a run's events into the same view a late joiner gets |
| turn-hibernate | A hibernated socket keeps working after the object is evicted. | src/sockets.ts:188 | local | W sockets › keeps serving a hibernated socket after the object is evicted |
| turn-dedupe | A submit resent with the same operation id runs once and is answered `accepted:false`. | src/sockets.ts:359 | local | W sockets › dedupes a submit resent with the same operation id after a dropped socket; P sends a message again after its socket drops before the answer, and pi takes it once |
| main-free | The main chat answers while a subagent or a machine task is still working. | src/subagents.ts:84, src/machines.ts:567 | local | W background › answers the user while a subagent is still working; W background › answers the user while a machine task is still working |
| report-after-tool | A report reaches the main agent after its current tool, not after its whole run. | src/subagents.ts:84 | local | W background › hands a report to the main agent after its current tool, not after its whole run |

## Side chats and titles

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| side-chat | New side chat starts a chat. The titles model names it from its first message. | src/server.ts:240, src/chats.ts:25, src/server.ts:249 | local | W features › starts a side chat whose title the titles model rewrites from its first message; P starts a side chat, names it from its first message, and goes back to the main chat |
| title-trim | A long title is trimmed. When the titles model fails, the first line is kept. | src/titles.ts:24, src/chats.ts:19 | local | W features › trims a long title, and keeps the first line when the titles model fails; W models › trims a long title to fit; W models › gives up quietly when the model fails or there is nothing to name |

## Models, and the Mac online or away

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| mac-online | While the Mac is online, the main agent and titles run on Claude. | src/models.ts:95, src/vibeproxy.ts:60 | local | W models › puts the main agent and titles on Claude while the Mac is online; W models › runs on Claude while the Mac is online |
| mac-away | While the Mac is away, every slot uses the cloud model and Claude shows as not connected. | src/settings.ts:74 | local | W models › puts every slot on the cloud model while the Mac is away, and shows Claude as not connected |
| mac-just-left | When the Mac has just gone away, a Claude slot runs on the fallback slot's model with its key, and goes back to Claude once the Mac returns. | src/models.ts:154, src/models.ts:288 | local | W models › gives a slot on Claude the fallback slot's model when the Mac has just gone away; W models › runs on the fallback slot's model, with its key, when the Mac has just gone away, and on Claude once it is back |
| slot-store | A slot choice is stored. A provider that is not connected is refused. | src/settings.ts:113 | local | W models › stores a slot choice, and refuses a provider that is not connected |
| slot-persist | A slot's model survives restarts. A model that doesn't exist is refused. | src/settings.ts:74 | local | W features › stores a slot's model across restarts and refuses one that does not exist; P picks a slot's model in settings and keeps it after a reload, with VibeProxy off |
| main-prompt | The main prompt offers Executor only when it is set up, and self-edits only once Settings has ky's repo, at the address of the page that set it. | src/prompt.ts:16, src/server.ts:185, src/setup.ts:73 | local | W features › offers self-edits in the main prompt once Settings has ky's repo, at the address of the page that set it |
| setup-repo | Settings sets ky's repo for self-edits and keeps it across reloads. Setting it takes the page's address as ky's, so a wrong one is fixed by setting the repo from the right page; Self-edits shows the address. A repo that isn't owner/name is refused in its row. | src/setup.ts:44, src/sockets.ts:619, src/ui/Panel.tsx:820 | local | P sets ky's repo for self-edits in Settings and keeps it after a reload; P shows why Settings refused ky's repo in its row, and keeps the repo unset; W features › offers self-edits in the main prompt once Settings has ky's repo, at the address of the page that set it |
| title-slot | Titles use Claude's small model without thinking while the Mac is online, the cloud model while it is away, and keep light thinking on the stand-in. | src/titles.ts:36, src/models.ts:288 | local | W models › asks Claude's small model without thinking while the Mac is online, and keeps the bare title; W models › asks the cloud model, still without thinking, while the Mac is away; W models › keeps its light thinking on the stand-in when the Mac has just gone away |
| image-support | The image check uses the model the slot runs on, or the fallback model while the slot's provider is away. | src/models.ts:166 | local | W models › checks the model the slot runs on; W models › checks the fallback model while the slot's provider is away |

## Images

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| image-send | Images reach the model and stay in the transcript. | src/images.ts:30 | local | W sockets › sends images to the model and keeps them in the transcript; P sends an image with a message, and refuses a fifth image |
| image-refuse | The server refuses images the model can't read, more than four images, ones that are too large, or the wrong kind. | src/sockets.ts:543, src/images.ts:30 | local | W sockets › refuses images the model can't read, or too many, too large, or the wrong kind |
| image-standin | When the stand-in can't read images, the server refuses them and the composer warns before sending. | src/sockets.ts:543, src/client.tsx:3 | local | P refuses an image the stand-in model can't read, never resends it, and warns before sending |

## Client

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| client-resend | After a reconnect, an unanswered message is sent again and pi takes it once. | src/use-pi-session.ts (onOpen, submit) | local | P sends a message again after its socket drops before the answer, and pi takes it once |
| client-resend-session | An unanswered message is resent only to its own chat. | src/use-pi-session.ts (onOpen) | local | P keeps an unanswered message for its own chat when the page switches chats |
| client-no-resend-refused | A refused submit is never resent. | src/use-pi-session.ts (error handler) | local | P refuses an image the stand-in model can't read, never resends it, and warns before sending |
| client-reload | A new deploy offers Reload, and only reloads by itself when there is no draft. | src/client.tsx:162 | local | P offers a reload when a new deploy is live and a draft would be lost |
| client-theme | The theme switch survives a reload. | src/client.tsx:63 | local | P switches the theme and keeps it after a reload |
| client-palette | The command palette opens from the keyboard and runs commands. | src/ui/CommandPalette.tsx:28 | local | P opens the command palette with the keyboard and runs a command |
| client-tools | Settings lists the tools ky can use. | src/ui/Panel.tsx:875 | local | P lists the tools ky can use |
| config-not-set-up | A deploy without VibeProxy or Executor configured starts, runs on the cloud model, and lists each under "Not set up" in Settings with what it needs. boundaryFor builds each only when all its config is set and non-empty. Without OPENCODE_API_KEY either, turns fail: the slot defaults end on OpenCode Go until node M replaces that default. | src/server.ts:304, src/server.ts:64, src/ui/Panel.tsx:783 | local | W features › shows VibeProxy and Executor as not set up on a deploy without them, and runs on the cloud model; W config › leaves out vibeProxy without VIBEPROXY, or with it empty; W config › leaves out executor without EXECUTOR_URL, or with it empty |
| config-stale-slot | A saved model whose provider this deploy no longer has falls through to the slot's defaults, in Settings and in turns. | src/settings.ts:80 | local | W features › falls back to the defaults when a saved model's provider is no longer set up |
| config-cloud-model | OpenCode Go offers pi-ai's first model of it once pi-ai drops ky's, so starting never throws. | src/models.ts:84 | local | W config › offers OpenCode Go's first model once pi-ai no longer has ky's |
| config-overlay | `pnpm start` and `pnpm run deploy` merge the owner overlay over wrangler.jsonc: its vars and VibeProxy tunnel are added, and the generic bindings stay. | wrangler-overlay.ts:10, vite.config.ts:26 | local | N overlay › adds the example overlay's vars and VibeProxy tunnel to wrangler.jsonc and keeps its bindings |
| client-skills | The Skills tab shows each skill, and edits, reverts and archives it. | src/ui/Skills.tsx:15 | local | P shows ky's skills, edits one, reverts it and archives it |
| client-lightbox | A task's screenshot opens in the lightbox. | src/ui/Lightbox.tsx:16 | local | P shows a task's screenshot and opens it in the lightbox |

## Tools in the cloud

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| memory-note | memory_note remembers a note and memory_recall finds it. | src/memory.ts:375 | local | W features › remembers a note and recalls it |
| memory-compress | After each note or forget, and on start, ky writes the summaries owed in the background on the main model; memory_zoom opens one, and memory_forget drops it to be rewritten. | src/memory.ts:282 | local | W features › writes summaries in the background on the main model, opens them, and rewrites a forgotten one |
| memory-compress-retry | A summary over 280 bytes is asked for again, shown where it must end, at most 4 tries, and the shortest is kept; a failed call stops and the next one finishes. | src/memory.ts: | local | W memory panel › asks again when a summary is over 280 bytes, showing where it must end, and keeps the shortest try; W memory panel › stops at a failed summary and writes it on the next call |
| chat-search | chat_search finds any message of the main chat and the side chats, every word first and some words after, with neighbors on request, leaving subagents out. | src/memory.ts:610, src/history.ts:56 | local | W features › finds any message of the main chat and the side chats with chat_search; W features › searches side chats by their title, and leaves subagents out |
| compact-early | pi is told a context window of at most 136k tokens, so a 1M model compacts near 87k instead of near 950k. | src/models.ts:330 | local | W features › tells pi a window of at most 136k tokens, so it compacts near 87k instead of near the model's 1M |
| skills-tools | skill_manage creates, patches and reverts a skill, keeping every version, and skill_view opens it and counts the use. | src/skills.ts:454, src/skills.ts:426 | local | W skills › creates, opens, patches and reverts a skill, keeping every version; H skills |
| skills-refuse | skill_manage refuses a bad name, a duplicate, and a patch that does not match exactly once. | src/skills.ts:96 | local | W skills › refuses a bad name, a duplicate, and a patch that does not match once |
| skills-index | Active skills are listed in the system prompt; archived ones are not. | src/skills.ts:396 | local | W skills › lists active skills in the system prompt, and drops archived ones |
| skills-review | A turn with enough tool calls is reviewed in a fork that wakes with memory and may only call the skill tools and memory_recall/memory_zoom, shown in the task feed. | src/skills.ts:431 | local | W skills › reviews a busy turn in a fork that remembers and may only touch skills; H skill-review |
| dreaming | Each night at 04:00 UTC ky reads what happened since the last dream in a fresh conversation that remembers, tends skills and memory with only those tools, shows one Dreaming row, and does nothing when nothing happened. | src/dreaming.ts:149, src/automations.ts:346 | local | W dreaming › is booked nightly, and does nothing when nothing happened; W dreaming › reads what happened since the last dream in a fresh conversation that wakes with memory; H dreaming |
| skills-panel | Skills go to the page on connect and on change; the user's edits, reverts and archives apply as "user", and history comes back on request. | src/sockets.ts:630 | local | W skills panel › sends skills on connect and on change, and takes the user's edits, history and reverts |
| workspace-files | A workspace file written by a tool outlives the object. | src/workspace.ts:101 | local | W features › writes and reads a workspace file that outlives the object |
| workspace-exec | exec runs JavaScript in the workspace. | src/workspace.ts:70 | local | W features › runs JavaScript in the workspace with exec |
| executor-tools | executor_skills, executor_execute and executor_resume reach Executor over MCP. | src/executor.ts:179 | local | W features › calls Executor over MCP |
| executor-once | A program runs once and the call answers with its result. | src/executor.ts:121 | local | W executor › runs a program once and answers with its result |
| executor-no-rerun | A program whose response was lost after it ran is never run again. | src/executor.ts:134 | local | W executor › never runs a program again when its response is lost after it ran |
| executor-expired | The call is retried once on a fresh session when Executor expired the old one. | src/executor.ts:134 | local | W executor › retries once on a fresh session when Executor expired the old one |
| executor-connect | The call is retried once when the connection can't be made, and a second failure is reported. | src/executor.ts:134 | local | W executor › retries once when the connection cannot be made, and reports a second failure |
| executor-no-401-retry | No retry when Executor refuses the token (401 or 403). | src/executor.ts:134 | local | W executor › does not retry when Executor refuses the token |
| executor-cancel | Stopping the turn cancels the call at Executor. | src/executor.ts:121 | local | W executor › cancels the call at Executor when the turn is stopped |

## Subagents

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| subagent-activity | A subagent's work shows in Activity, and its chat opens from there. | src/subagents.ts:84 | local | P shows a subagent's work in Activity and opens its chat |
| subagent-stop | A subagent's work can be stopped from the task list. | src/subagents.ts:84 | local | W features › stops a subagent's work from the task list |
| subagent-steps | Each tool a subagent uses is a step on its task, and each model response adds a turn and its cost; the task keeps when it started and finished. | src/subagents.ts:331 | local | W features › shows a subagent's tool steps, turns, and how long it took |
| subagent-follow-up | A message sent as a follow-up waits for the whole run before it is answered. | src/subagents.ts:84 | local | W features › waits for a whole run before answering a message sent as a follow-up |

## Specialists

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| specialist-brief | A brief's versions are numbered apart from SOUL.md's; patch and revert add versions, and a bad id is refused. | src/soul.ts:193, src/specialists.ts:572 | local | W specialists › keeps every brief version apart from SOUL.md's |
| specialist-manage-rules | Every chat is told ky can make and manage specialists, even before there are any. | src/specialists.ts:265 | local | W specialists › tells ky it can make specialists before there are any |
| specialist-panel | The Soul tab lists specialists; one is created, its brief edited and reverted there, and a duplicate is refused. | src/sockets.ts:257 | local | W specialists › is listed, saved and edited from the panel; P creates a specialist in the Soul tab, edits its brief and reverts it |
| specialist-ask | An ask runs in the specialist's home conversation on its brief, without the memory wake or SOUL.md, and reports to the chat. | src/subagents.ts:404, src/specialists.ts:268 | local | W specialists › answers an ask from its home conversation, on its brief, without memory |
| specialist-home | The main chat and a side chat share one home conversation per specialist. | src/subagents.ts:421 | local | W specialists › shares one home conversation between the main chat and a side chat |
| specialist-consult | A specialist consults a peer in a fresh conversation, shown as "@a → @b", which cannot ask on. | src/specialists.ts:491, src/subagents.ts:440 | local | W specialists › consults a peer in a fresh conversation, which cannot ask on |
| specialist-memory | A specialist searches memory but never writes it, and has no specialist or soul_edit tool. | src/specialists.ts:487 | local | W specialists › reads memory but never writes it, and has no persona tools |
| specialist-discuss | A discussion of 2 to 4 specialists reports every round back to the chat; one specialist is refused. | src/specialists.ts:361, src/subagents.ts:464 | local | W specialists › holds a discussion and reports both rounds back |
| specialist-mention | An @ that is not a specialist is refused with the list. | src/sockets.ts:560 | local | W specialists › refuses an @ that is not a specialist |

## Machine tasks

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| task-run | A task runs on a machine as Claude Code or Codex, shows its session and steps, takes a follow-up, and reports its result with its turns and, for Claude Code, its cost. Codex reports one turn per process and no cost: on a subscription nothing says what a turn costs. A Codex follow-up resumes its thread, given ky's task instructions again. | src/machines.ts:356, src/machines.ts:391, runner/runner.ts:239, runner/runner.ts:367 | local | W features › runs a task, shows its session and steps, takes a follow-up, and reports its result and spend; H machine-run; H follow-up; H codex-run; H codex-follow-up; P runs a task on a machine and shows its report; W runner-protocol › runs two messages sent while a Codex turn runs in order, each in its own process resuming the thread |
| task-steps | Each tool the agent uses on a machine is a step on the task ("Running pnpm build"). Codex's commands and file changes read as the Claude Code tool they are most like (Bash, Write, Edit), and a deleted file as "Deleting <file>". The card shows the newest step and the elapsed time while it runs, the last few steps when opened, and its duration, turns and cost once it ends. | runner/runner.ts:335, runner/codex.ts:68, src/tasks.ts:250, src/ui/Panel.tsx:479 | local | H steps; H codex-run; P shows what a machine task is doing, then how long it took and what it cost |
| topbar-background | While the open chat is idle, the topbar says what the newest background step is ("webmac: Running pnpm build"). | src/ui/task-progress.ts:52, src/ui/open-chat.ts:82 | local | P shows what a machine task is doing, then how long it took and what it cost |
| task-report-sender | A task's report goes to the conversation that sent its turn, the main chat or a side chat. A message from the task list goes to whoever sent the task's last turn. | src/machines.ts:194, src/machines.ts:391 | local | W runner-protocol › reports a task a side chat started to that side chat, not the main conversation; H side-chat-report |
| task-steer-fold | A message sent while a Claude Code task works joins the running turn, and that turn's one result ends the task. The runner counts the messages Claude Code echoes (--replay-user-messages), so the task doesn't stay working. Codex takes no message mid-turn: one sent then waits for the turn to end and runs as the next turn, resuming the thread, and the tool says so. | runner/runner.ts:293, runner/runner.ts:314, src/machines.ts:791 | local | W runner-protocol › ends a turn that took in a message sent while it ran, with one report; H steer-folded; H codex-queued; W runner-protocol › runs two messages sent while a Codex turn runs in order, each in its own process resuming the thread |
| task-chat | A plain chat works end to end through the stack. | src/sockets.ts:295 | local | H chat |
| task-withdraw | A task the runner hasn't picked up is withdrawn. A picked-up task is sent a stop. | src/machines.ts:442, runner/runner.ts:274 | local | W features › withdraws a task the runner has not picked up, and sends a stop to one it has; H stop; H codex-stop; P stops a machine task from Activity |
| task-stop-all | Stop all in Activity stops every working task at once. | src/sockets.ts:403, src/ui/Panel.tsx:213 | local | P stops every working task at once from Activity |
| activity-recent | Activity lists what is running now, then automations, then the ten most recent finished tasks by day. Show earlier adds twenty more at a time, and the revealed rows fade in. | src/ui/Panel.tsx:254 | local | P lists automations above the history, and only recent tasks until Show earlier |
| task-interrupted | A working task is marked interrupted when its runner restarts without it. | src/machines.ts:464 | local | W features › marks a working task interrupted when its runner restarts without it |
| task-files | A machine task's file is shared, and served whole or by range. | src/files.ts:100, src/files.ts:142 | local | W features › shares a machine task's file, and serves it whole and by range |
| task-screenshot | A screenshot taken through ky-attach shows on the task, from a Claude Code or a Codex task. Codex's commands get the runner's whole environment, so KY_TOKEN reaches ky-attach and ky-diff: Codex would drop every variable named like a token by default. | runner/ky-runner.ts:75, runner/codex.ts:24 | local | H screenshot; P shows a task's screenshot and opens it in the lightbox; H codex-attach |
| machine-choice | The user sets each machine on, paused or off, and a note on what it is for, from Settings or through the agent. The tool refuses a new task on a machine that isn't on, a follow-up on one that is off, and asks the agent to name a machine when more than one is on and online. | src/machines.ts:270, src/machines.ts:690, src/sockets.ts:453, src/ui/Panel.tsx:382 | local | W features › lets the user choose which machines take work, and tells the agent what each one is; P pauses a machine and notes what it is for in Settings, and the agent is refused it |
| machine-facts | The runner tells ky its OS, whether tasks drive the user's Chrome, its git repos with their remotes (credentials removed), whether Claude Code (`claude auth status`) and Codex (`codex login status`) are installed and signed in, that it shares no ports, and that it is one of the user's computers. Both logins are asked through one helper, in the background, and an answer that says nothing keeps the last one. A CLI last found missing is looked for again each time the facts are read, so one installed since is not turned away. The agent reads them in `list` and wherever it is asked to choose: "runs Claude Code and Codex", "runs Claude Code, Codex not signed in". | runner/ky-runner.ts:185, runner/ky-runner.ts:219, runner/ky-runner.ts:248, src/machines.ts:623 | local | W features › lets the user choose which machines take work, and tells the agent what each one is; W features › runs a task as the agent asked for, else the machine's own, and its follow-ups as the same one; H machine-facts |
| machine-move | A task that has not reached a runner moves to another machine that is on and runs its agent, and keeps that agent. One that has run stays, since its session is on that machine. | src/machines.ts:405 | local | W features › lets the user choose which machines take work, and tells the agent what each one is; H codex-move |
| task-diff | ky-diff shares a repository's changes since the branch forked, untracked files included, and the task shows them as a collapsible file list with +/- counts and Pierre diffs. | runner/diff.ts:38, src/ui/Changes.tsx:97 | local | W review › diffs from where the branch left the default branch, with new untracked files; W features › shares a task's diff, and sends the user's comments on it to the task |
| task-diff-feedback | Line comments on a task's diff go to the task as one message, with file:line and the code. | src/ui/review.ts:44, src/sockets.ts:429 | local | W review › writes every comment up as one message, in file and line order, with file:line and the code; W features › shares a task's diff, and sends the user's comments on it to the task |
| runner-reconnect | The runner reconnects after the socket closes, says hello, then flushes its outbox. | runner/ky-runner.ts:446, runner/runner.ts:138 | local | H reconnect |
| runner-reconnect-outage | A runner whose retry fails (503, or nothing listening) keeps retrying and reconnects. Node's WebSocket fires only `error` when a handshake fails, and the runner retries on it. | runner/ky-runner.ts:466 | local | H reconnect-outage |
| runner-stop-race | A stop sent while the run's ack is in flight stops the run, with one report and no "Stopped before it started". | src/machines.ts:442 | local | W runner-protocol › stopRace: a stop racing the ack stops the run, with one report |
| runner-offline-result | A result that finished offline is sent right after the reconnect hello, which lists its task as active, so it is reported once, as done, not Interrupted. | runner/runner.ts:138, runner/runner.ts:184 | local | W runner-protocol › helloBeforeOutbox: a result finished offline is reported once, as done; W runner-protocol › reports a Codex result finished offline once the runner is back, as owed in its hello |
| runner-run-once | A run whose ack was lost runs once across a runner restart: handled seqs are on disk (KY_STATE_DIR) before the ack. | runner/handled.ts:18, runner/runner.ts:210 | local | W runner-protocol › dupExec: a run whose ack was lost runs once across a runner restart |
| runner-steer-after-stop | A message sent while a task is stopping starts a new session after the stop, resuming it. | runner/runner.ts:239 | local | W runner-protocol › steerIntoStop: a message sent while stopping starts a new session after it |
| runner-lost-reports | A task whose reports were lost with the socket ends as Interrupted instead of staying queued. | src/machines.ts:464 | local | W runner-protocol › stuckQueued: a task whose reports were lost ends instead of staying queued |
| runner-order | Turns reach Claude Code in the order they were sent, even when a follow-up comes before the hello is handled. | src/machines.ts:303 | local | W runner-protocol › reorder: turns reach Claude Code in the order they were sent |
| runner-protocol-version | Runner and object speak protocol 3. The object reads a hello's `protocol` before the rest; a runner on `/runner/<machine>` that speaks another protocol gets `goodbye` with the one ky expects, then close 4426, and exits. The runner says hello before anything it made offline. Every other frame is decoded against the protocol: a malformed report closes the runner's socket with 1008, and the runner ignores a malformed command. | src/runner-protocol.ts:252, src/sockets.ts:466, runner/ky-runner.ts:413, runner/runner.ts:138 | local | W runner-protocol › says goodbye to a runner of another protocol, and closes its socket as outdated; H outdated-runner; H outdated-runner-exits; W runner-protocol › decodes runner frames: a malformed report closes the runner's socket; W runner-protocol › decodes commands: the runner ignores a run without a prompt |
| runner-turn-fence | A repeated result posts once, and a late step does not reopen the task. | src/machines.ts:528 | local | W runner-protocol › fences turns: a repeated result posts once, and a late step does not reopen the task |
| runner-stop-unsent | A task the runner never got is stopped before it starts, and never runs later. | src/machines.ts:442 | local | W runner-protocol › stops a task the runner never got before it starts |
| runner-stop-queued | A second stop also drops the turn queued behind the first. | runner/runner.ts:274 | local | W runner-protocol › drops a turn queued behind a stop when it is stopped too; W runner-protocol › stops a Codex turn with a message queued behind it, and says once that it was dropped |
| runner-keepalive-race | A keepalive hello sent before a run arrived does not end that run. | src/machines.ts:464 | local | W runner-protocol › keeps a run that a keepalive hello raced |
| runner-one-socket | One socket per machine: a second runner's hello replaces the first, which exits. | src/sockets.ts:448, runner/ky-runner.ts:413 | local | W runner-protocol › keeps one socket per machine: a second runner's hello replaces the first |
| runner-socket-path | A runner connects to `GET /runner/<machine>`, signed in like any request, and the Worker sends it to the one agent, which tags the socket as that machine. A path that names no machine is a 404 and a request that is not a socket a 426. A machine is kept once its runner says a valid hello, not before. `?runner=` on the agent's own path is just a browser socket. | src/server.ts:421, src/runner-protocol.ts:225, src/sockets.ts:60, src/machines.ts:464, runner/ky-runner.ts:423 | local | W the runner's WebSocket › goes through the Worker, signed in, to the one agent, as the machine its path names; W the runner's WebSocket › leaves `?runner=` alone: the agent's path opens a session socket, not a machine's; H machine-run; W the runner's WebSocket › turns away a path that names no machine, and a request that is not a socket; W the runner's WebSocket › keeps no machine for a runner that never says a valid hello |
| runner-agent | Every run names its agent (runs queued before this protocol become Claude Code's), and every result says which agent ran it. The runner runs each through its own adapter (runner/claude.ts, runner/codex.ts). A run for an agent the machine does not have installed ends failed, saying so; one whose login looked signed out, or never answered, starts anyway, and the CLI's own error is the result. | src/machines.ts:62, src/machines.ts:164, runner/runner.ts:46, runner/runner.ts:239 | local | W runner-protocol › refuses a run for an agent this machine does not have, and starts one that looks signed out |
| task-agent | The machine tool runs a task as the agent asked for (`agent`), else as the one the machine has, Claude Code first and a signed-in one before one that is not. It refuses an agent the machine does not have installed, naming a machine that runs it; one that looks signed out is not refused, since the user may have signed in since. The task keeps its agent, its follow-ups go to it, and `list` shows it. Older machine tasks are Claude Code's. | src/machines.ts:83, src/machines.ts:92, src/machines.ts:773, src/tasks.ts:125 | local | W features › runs a task as the agent asked for, else the machine's own, and its follow-ups as the same one; W features › lets the user choose which machines take work, and tells the agent what each one is; H codex-run |
| codex-home | Each Codex task runs in its own CODEX_HOME under KY_STATE_DIR, which keeps its threads for follow-ups and none of the user's Codex config, and signs in with the machine's own `codex login`: its auth.json links to the machine's. It keeps no prompt history, plugins or memories, and the runner deletes one 14 days after its last turn, when it next reads its facts; a follow-up after that fails. | runner/ky-runner.ts:322, runner/ky-runner.ts:341, runner/codex.ts:24 | local | H codex-run; H codex-follow-up; H codex-home-sweep |
| runner-no-ports | The runner answers a request to a local port with an error, since it shares none. | runner/runner.ts:172 | local | W runner-protocol › answers a request to a port with an error: the machine shares none |

## Automations

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| automation-create | The automation tool makes a recurring automation (cron in UTC) from chat and books its schedule. | src/automations.ts:197 | local | W automations › creates an automation from chat and books its schedule |
| automation-run | A run is a background subagent task `a-<id>-<slot>` with source `automation:<id>`, on the automation's own model, and its result reaches the chat once. | src/automations.ts:403 | local | W automations › runs an automation on its own model and reports once to the chat that made it; H automation-run |
| automation-one-per-slot | A slot that fires again, during its run or after an eviction, starts no second task and posts no second report. | src/automations.ts:349, src/automations.ts:373 | local | W automations › runs one task and one report when a slot fires again during its run and after an eviction |
| automation-model | A model that is not offered is refused with the choices; an automation without one runs on the subagents slot. | src/automations.ts:517, src/automations.ts:524 | local | W automations › refuses a model that is not offered and runs a model-less automation on the subagents slot |
| automation-overlap | A slot is skipped while the automation's last run is still queued or working. | src/automations.ts:380 | local | W automations › skips a slot while the last run is still working |
| automation-pause | Pause stops the live run, books nothing more, and keeps its report out of the chat; resume books from now. | src/automations.ts:501, src/subagents.ts:207, src/machines.ts:580 | local | W automations › pause stops the live run and books nothing more; resume books from now; W automations › a one-off paused while it fires stays paused and posts no report |
| automation-update | Update saves the change and rebooks the schedule; a bad cron is refused and the old booking kept. It can clear a model or machine, and refuses an empty title or prompt. | src/automations.ts:229, src/automations.ts:618, src/automations.ts:689 | local | W automations › update rebooks the schedule; W automations › update clears a model and a machine, and refuses an empty prompt |
| automation-delete | Delete cancels the schedule, stops a live run and removes the automation; its past runs stay in Activity. | src/automations.ts:294 | local | W automations › delete cancels the schedule and removes the automation, keeping its past runs; P adds, edits, runs and deletes an automation from Activity |
| automation-archive | Archive cancels the schedule; unarchive brings the automation back paused. | src/automations.ts:268, src/automations.ts:306 | local | W automations › archive cancels the schedule; unarchive brings it back paused |
| automation-recover | When the object starts, an active automation whose schedule was lost is booked again. | src/automations.ts:337 | local | W automations › books lost schedules again when the object starts |
| automation-machine | An automation with a machine runs there as a machine task, enqueued once per slot even when the slot fires twice; on a machine the user paused or turned off, the run fails and says why. | src/automations.ts:447, src/machines.ts:356 | local | W automations › a machine automation enqueues its run once when a slot fires twice; W automations › a machine automation on a machine the user paused fails its run and queues nothing; H automation-machine |
| automation-self | ky can schedule a one-off for itself; it runs once, reports, and ends done. | src/automations.ts:473, src/prompt.ts:28 | local | W automations › ky schedules a one-off for itself, which runs, reports, and ends done; W automations › a one-off whose slot already ran ends done, and resuming it is refused |
| automation-chat | Runs report to the chat that made the automation, or the one named; an archived side chat is unarchived, and a deleted one falls back to the main chat. | src/automations.ts:390 | local | W automations › reports to the side chat that made it, unarchiving it if needed |
| automation-activity | Activity lists active and paused automations, under Now and above the task history, with their schedule, next and last run. A row opens its editor; Run now, Pause and Resume show on hover. | src/ui/Automations.tsx:115, src/sockets.ts:182 | local | P pauses, resumes and archives an automation from Activity |
| automation-editor | Activity adds and edits automations: title, prompt, a cron or one time, model and thinking, cloud or machine, and the chat it reports to. A refusal shows in the form; Archive and Delete are in the editor. | src/ui/Automations.tsx:432, src/sockets.ts:205 | local | P adds, edits, runs and deletes an automation from Activity |

## Vault

The Vault object keeps ky's secrets and the tokens it hands out. Nothing calls it yet; pairing, keys and subscriptions wire it in.

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| vault-secrets | Secrets are put, replaced and removed by kind and id; status lists each with its meta and never its value. | src/vault.ts:77, src/vault.ts:92 | local | W vault › puts, replaces and removes secrets, and status lists them without their values |
| vault-tokens | A minted token is returned once and only its sha-256 is kept. It checks as its subject for its own kind, until it is revoked, replaced by a newer mint, or past its ttl; a ttl that isn't a positive number is refused. | src/vault.ts:165, src/vault.ts:191 | local | W vault › mints a token that checks as its subject for its own kind only, and stores only its sha-256; W vault › tells subjects apart, and minting again replaces the subject's last token; W vault › revokes a subject's token and no other; W vault › refuses a token once its ttl has passed, and forgets it at the next mint; W vault › refuses a ttl that isn't a positive number of milliseconds, and stores nothing for it |
| vault-consume | A token can be consumed once: of callers racing with it, one gets its subject and the rest get null. | src/vault.ts:207 | local | W vault › consumes a token once: of two racing callers, one gets its subject |
| vault-refresh | Concurrent refreshes of one stored generation share one run. A put or remove that lands first wins, even with the same value, whether the refresh succeeded or failed. A failed refresh of an unchanged secret, including one that returns nothing JSON can hold, leaves its error in status until a refresh or put next writes it. | src/vault.ts:126, src/vault.ts:228 | local | W vault › shares one refresh among concurrent callers and stores its result; W vault › drops a refresh that a put or remove beat, and answers with what is stored now; W vault › lets a put of the very same value beat a refresh, and runs a new refresh for callers after it; W vault › answers a failed refresh that a put or remove beat with what is stored now, and records no error; W vault › keeps a failed refresh's error on the secret until a refresh or put next writes it, and runs nothing for a missing one; W vault › fails a refresh that returns nothing or what JSON can't hold, and keeps the secret |

## Setup CLI

`ky`, built by `pnpm compile` with the release inside it, deploys ky to the user's own Cloudflare account with the user's login for that run; it keeps no Cloudflare token. The checks run it in-process against test/fakes/cloudflare.ts.

| id | behaviour | cite | tag | check |
|---|---|---|---|---|
| cli-deploy | `ky init` writes the overlay (account, name, vars), then deploys the Worker with the release's config and bindings, every migration, `ACCESS_*`, a bucket named from the Worker and each R2 binding (a name R2 won't take is refused before anything is written) and a KY_TOKEN that is printed once. | cli/init.ts:157, cli/deployer.ts:439, cli/deployer.ts:121 | local | N cli › ky init and deploy › deploys the Worker with the release's config, every migration, ACCESS_* and a KY_TOKEN shown once; N cli › ky init and deploy › deploys a release's new bindings to an existing overlay; N cli › ky init and deploy › refuses a name whose bucket R2 wouldn't take, before anything is written |
| cli-access | The deploy sets up an Access app that lets only the owner in, and a bypass app for exactly the C2 paths, both tagged `ky`; it finds them by what they guard and their tag, never by name. | cli/deployer.ts:350, cli/deployer.ts:382 | local | N cli › ky init and deploy › sets up an Access app for the owner and a bypass app for the C2 paths; N cli › ky init and deploy › finds ky's Access apps by what they guard and their tag, not by name |
| cli-upgrade | `ky upgrade` runs only the migrations the Worker hasn't run (its tag read where wrangler reads it), keeps its KY_TOKEN, and updates the Access apps in place; a ky older than the Worker says to get a newer one. | cli/deployer.ts:230, cli/commands.ts:66 | local | N cli › ky init and deploy › upgrades without running migrations again, keeps the KY_TOKEN and the Access apps, and runs only a new migration; N cli › ky init and deploy › tells a ky older than the Worker to get a newer one, rather than to upgrade |
| cli-assets | A deploy uploads only the web app's files Cloudflare doesn't have. | cli/deployer.ts:304 | local | N cli › ky init and deploy › uploads only the web app's files Cloudflare doesn't have |
| cli-ownership | A Worker, bucket or Access app of the deploy's that ky didn't make (the owner's production `ky` and `ky-files`, or an app already guarding the address, say) is never changed, emptied or removed, and teardown leaves a bucket another Worker binds. | cli/deployer.ts:162, cli/deployer.ts:178, cli/deployer.ts:190, cli/deployer.ts:350, cli/deployer.ts:632 | local | N cli › ky init and deploy › refuses a Worker or bucket of that name ky didn't make, and writes nothing; N cli › ky init and deploy › refuses an Access app on the address ky didn't make, and leaves it alone; N cli › ky teardown › leaves a Worker of that name ky didn't deploy alone; N cli › ky teardown › leaves a bucket another Worker binds, and the production ky Worker's bucket |
| cli-init-prereqs | `ky init` waits for Zero Trust, sets the workers.dev subdomain, and names the token scopes to create when the login can't manage Access; without a terminal, each missing answer names its flag. Run again, it fills in only what the overlay lacks; a failed deploy keeps the settings and says to retry with `ky deploy`. | cli/init.ts:68, cli/init.ts:97, cli/init.ts:113, cli/init.ts:133 | local | N cli › ky init and deploy › asks for Zero Trust, a workers.dev subdomain, and a token that can manage Access; N cli › ky init and deploy › fills in what the overlay lacks, and keeps what it has; N cli › ky init and deploy › keeps the settings when the deploy fails, and says to retry with ky deploy |
| cli-doctor | `ky doctor` checks each piece of the deploy, reports a refused login, a name ky didn't make or a ky older than the Worker as a failed check, and prints the command or dashboard step that fixes the first one missing, or JSON with `--json`. Following each Next leads to a deploy that passes. | cli/commands.ts:101, cli/deployer.ts:502, cli/deployer.ts:598 | local | N cli › ky doctor › prints each check; N cli › ky doctor › reports a login Access refuses, and a Worker ky didn't deploy, as checks; N cli › ky doctor › with $state, each Next leads to a deploy that passes; N cli › ky init and deploy › tells a ky older than the Worker to get a newer one, rather than to upgrade |
| cli-teardown | `ky teardown --confirm <name>` removes the Worker with its data and secrets, then its Access apps and the emptied bucket, then the overlay; when it can't find the Access apps (the workers.dev subdomain is gone) it says where to remove them and keeps the overlay. | cli/deployer.ts:695, cli/commands.ts:145 | local | N cli › ky teardown › removes the Worker with its data and secrets, then its Access apps and the emptied bucket, then the overlay; N cli › ky teardown › says it can't find the Access apps once the workers.dev subdomain is gone, and keeps the overlay |
| cli-errors | A failure, a bad flag among them, prints `ky: <message>` rather than a stack. | cli/ky.ts:41 | local | N cli › the ky command › prints a bad flag's message rather than a stack, and help |
| cli-release-pack | The compiled `ky` carries the release it deploys. | cli/release.ts:37, cli/binary.ts:1 | local | N cli › the release pack › carries the release the compiled ky deploys |

## Live-only

These need a real outside service, so the local gate can't cover them.

| id | behaviour | cite | tag | check | why it is live-only |
|---|---|---|---|---|---|
| live-login | The deployed worker serves the login form. | src/auth.ts:68 | live-only | L login | Needs the deployed worker. |
| live-auth | The deployed worker accepts KY_TOKEN and refuses requests without it. | src/auth.ts:43 | live-only | L auth | Needs the deployed worker and the real token. |
| live-hello | A deployed socket says hello with the machine tool. | src/sockets.ts:234 | live-only | L hello | Needs the deployed object. |
| live-cloud | The OpenCode Go key answers a completion. | src/models.ts:95 | live-only | L cloud | Needs a real key. Locally the faux provider stands in and the key swap is checked as "faux-key". |
| live-vibeproxy | VibeProxy on the Mac answers through the tunnel to Claude. | src/vibeproxy.ts:60 | live-only | L vibeproxy | Needs the Mac, the tunnel and a Claude login. |
| live-browser | browse drives a real Browser Rendering page. | src/browse.ts:53 | live-only | by hand: ask ky to browse a page | Locally a CDP fake stands in for the browser. |
| live-executor | Executor runs real accounts and approvals. | src/executor.ts:179 | live-only | by hand: run executor_skills, then a program that needs approval | Locally an MCP fake stands in for Executor. |
| live-claude-cli | The runner drives the real `claude` CLI on the Mac. | runner/ky-runner.ts | live-only | by hand: start a machine task with the runner on the Mac | The harness uses test/fakes/claude.ts. |
| live-ky-init | On a clean account, the compiled `ky init` ends with ky behind Access, and `ky teardown` removes it. | cli/init.ts:80 | live-only | by hand: `ky init`, `ky doctor`, `ky teardown --confirm ky` on a spare account | Needs a real Cloudflare account; the local checks use test/fakes/cloudflare.ts. |
| live-codex-cli | The runner drives the real `codex` CLI: a task runs, a follow-up resumes its thread, a stop interrupts it, and a token Codex refreshes reaches the machine's auth.json through the link. | runner/codex.ts:93, runner/ky-runner.ts:322 | live-only | by hand: run a task with `agent: "codex"` on the Mac, follow it up, stop one | The harness uses test/fakes/codex.ts, which does not refresh tokens. |

## Known gaps that have no fix yet

- When the Mac leaves or comes back, open pages aren't told. The header and Settings stay stale until a reload. The server still refuses what the stand-in can't do (`image-standin`).

## Counts

- Local features: 137.
- Live-only features: 10.
- Known broken: none. `pnpm harness` has no expected failures.
