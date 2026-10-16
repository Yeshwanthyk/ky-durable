# How ky is built

A personal agent that lives in one Cloudflare Durable Object and answers in any browser. It is built on Pi
Durable (`agents/harness/pi`, `@earendil-works/pi-durable`). One user, one object. The README says how to set it
up; this is how it works.

## Where things run

```
browser ──wss /agents/pi-agent/me?session=<id>──┐
                                                ├─ Worker (Access) ── PiAgent DO "me" (SQLite) ── Vault DO "owner"
computer: ky runner run ──wss /runner/<name>────┤        │
CloudMachine container: ky runner cloud ────────┘        ├─ AI       Workers AI (no key)
                                                         ├─ LOADER   exec sandbox (Dynamic Workers)
                                                         ├─ BROWSER  Kitesurf browser (browse tool)
                                                         ├─ FILES    R2 bucket <worker>-files
                                                         ├─ EMAIL    Email Service: ky's own address (send; Email Routing → email handler)
                                                         ├─ Executor MCP (HTTPS)
                                                         ├─ API-key vendors (HTTPS)
                                                         └─ VibeProxy on a computer, over its runner socket (or a VPC tunnel)
```

| Piece | What it does | Where |
| --- | --- | --- |
| Worker | Checks Access's sign-in, serves the UI assets, stores uploads in R2, routes WebSockets to the DO. | `src/server.ts` (default export), `src/access.ts`, `src/files.ts` |
| `PiAgent` DO, named `"me"` | The agent: pi conversations, tools, the task feed, machines, settings. Everything is in its SQLite. | `src/server.ts` (`PiAgent`), `src/sockets.ts` |
| Browser UI | React app; one WebSocket per open chat, rebuilt from a snapshot on reconnect. | `src/client.tsx`, `src/ui/*`, `src/use-pi-session.ts` |
| exec sandbox | `exec` runs JavaScript in a fresh Dynamic Worker over the DO's workspace (`/workspace`). No network except git over HTTPS, no shell or npm. | `src/workspace.ts`, binding `LOADER` |
| Kitesurf browser | `browse` opens a cloud page, runs steps, reads it, closes it. No logins. Subagents only; the main agent delegates it. | `src/browse.ts`, binding `BROWSER` |
| R2 `ky-files` | Screenshots and recordings that machine tasks share (25 MB cap). | `src/files.ts`, binding `FILES` |
| Email Service | ky's own address (`KY_MAIL_ADDRESS`). Email Routing hands mail to the Worker's `email` handler, which parses it and passes it to the DO; each mail is read in a background conversation that may call no tool, and reported where it matters. The `mail` tool sends with the `EMAIL` binding: at once to the user's addresses and ones they allowed, otherwise held until the user sends it in Settings › Mail. | `src/mail.ts`, `src/ui/Mail.tsx`, binding `EMAIL` |
| Executor | The user's connected apps over MCP (`executor_skills`, `executor_execute`, `executor_resume`). | `src/executor.ts`; its URL and token are added in Settings › Tools › Executor and kept in the Vault |
| Workers AI | Models every deploy has, with no key: GLM 5.3 Flash, Kimi K2.6 and GPT OSS 120B, through AI Gateway's default gateway. The background model, and main's when nothing better is connected. | `src/providers/workers-ai.ts`, binding `AI` |
| API-key vendors | Anthropic, OpenAI and OpenCode Go, each paid with a key the user adds in Settings. A test call must take the key before it is saved in the Vault, and every request reads it from there. Their models outrank Workers AI's. | `src/providers/api-key.ts`, `src/vault.ts` |
| VibeProxy on a computer | Claude in ky's chat: VibeProxy on port 8317 of a paired computer that shares it, reached over that computer's runner socket; or, from a checkout, the `VIBEPROXY` Workers VPC service over a cloudflared tunnel. Probed on demand with a 30 s cache; when down, its calls run on a stand-in on another provider. | `src/providers/vibeproxy.ts`, `src/pipe.ts` |
| `ky runner run` on each machine | Dials out to the DO and runs each machine task as a Claude Code (`claude -p`) or Codex (`codex exec`) session. Nothing listens on a port. | `cli/runner/` |
| Cloud machine | A container on the user's account (Workers Paid) running `ky runner cloud`, so tasks run with every computer off; git and `ky github` reach GitHub through the Worker's `github.internal`, which holds the token. | `src/cloud.ts`, `src/github.ts`, `src/github-tools.ts`, `cli/runner/cloud.ts`, `cli/runner/github.ts`, `container/Dockerfile` |

**SQLite tables in the DO.** pi's own conversation store, plus:
`ky_tasks` (task feed, `src/automations/tasks.ts`), `ky_machine_inbox`, `ky_machines` and `ky_machine_turns` (`src/machines/machines.ts`),
`ky_chats` (side chats, `src/chats.ts`), `ky_automations` (`src/automations/automations.ts`), `ky_providers` (`src/providers/records.ts`),
`ky_purposes` (each purpose's model, `src/settings.ts`),
`memo_log` and `memo_tree` (memory, `src/dreaming/memory.ts`), `ky_skills`, `ky_skill_versions` and `ky_skill_reviews` (`src/skills/skills.ts`),
`ky_dream` (`src/dreaming/dreaming.ts`), `ky_dream_ledger` (each change a dream made, for undo, `src/dreaming/ledger.ts`), `ky_presence` (`src/dreaming/presence.ts`), `ky_anticipations` (`src/dreaming/anticipations.ts`), `ky_brief` (`src/dreaming/brief.ts`), `ky_surfaced` (what ky showed unasked and its outcome, `src/dreaming/surfaced.ts`), `ky_proactivity` (`src/dreaming/proactivity.ts`), `ky_avatars` (`src/avatars.ts`), `ky_files` (`src/files.ts`), `ky_mail`, `ky_mail_allowed` and `ky_mail_expect` (`src/mail.ts`), and the workspace files.

**What the agent can do.**
- Memory: a port of [OptMem](https://github.com/VictorTaelin/OptMem) (`memory_note`, `memory_recall`, `memory_zoom`, `memory_forget`), shared by the main chat and its side chats. Summaries are written in the background on the main model. `chat_search` finds any message of the main chat and the side chats.
- Skills: procedures the agent writes for itself, after Hermes Agent (`skill_view`, `skill_manage`, `src/skills/skills.ts`).
  Every conversation sees the list. After a main-chat or side-chat turn with 5 or more tool calls, ky forks the
  conversation and asks the fork to update skills; it shows in Activity as "Skill review", and can call only the
  skill tools. Writes apply at once and every one is kept as a version, so `revert` undoes it. Memory holds facts;
  skills hold how to do a kind of task. The panel's Skills tab lists them, with edit, history, revert and archive
  (`src/ui/Skills.tsx`). Machines can't see skills, so ky opens the matching one and puts its steps in the task.
  A review fork keeps the memory its chat was shown and may search it (`memory_recall`, `memory_zoom`), but not write it.
  Each skill keeps when it was last opened, and each version the conversation that made it.
- Dreaming: once a night (04:00 in the zone the user's browser connects from, booked on the automations Scheduler
  and again when the zone changes), ky reads what happened since the last dream (what was said in the main chat
  and the side chats, new memories, skill changes, skill use, finished tasks) in a fresh conversation that wakes with
  memory, notes what the user said that memory lacks, and
  tends the skills: creates one for a task that keeps coming up, merges overlaps, archives ones unused for 60 days,
  and fixes ones a later correction contradicts (`src/dreaming/dreaming.ts`). It may call only the skill tools and memory's;
  it keeps to OptMem's rules, so it never edits the log: it corrects a memory with a new note plus `memory_forget`
  on the stale summary, is told to note at most 15, and pays the compressions its notes make due. It shows in Activity as
  "Dreaming", and skips the night when nothing happened. What was said comes from chat search (`src/history.ts`
  `since`), oldest first: the user's messages get the room, ky's and notices are cut short, and what does not fit
  waits for the next night, which starts after the last one read by pi's commit sequence. A user entry ky posted for
  someone else (a mail's summary, a peer's question, a report) is labelled `notice`, never `user`, by its
  submission's request id. While the user sent a message in the last 2 hours (`ky_presence`,
  `src/dreaming/presence.ts`; a connecting tab does not count) it books one look for 2 hours after, until 08:00 their
  time, when it leaves the night's reading to the next. It also books check-ins (below).
- Anticipations: what ky expects to matter soon, in `ky_anticipations` (`src/dreaming/anticipations.ts`): an open
  loop the user committed to, a date ahead, a question likely next, or something to watch, each citing the chat
  messages or memories it rests on (refused without), with up to 1,500 characters of prepared context and an optional
  window. The `anticipate` tool (on memory's extension, so specialists cannot call it) adds, closes, extends, absorbs,
  pins (the user only) and lists them, all open or by words (`match`) or the hours ahead (`due`): the dream as `dream`, at most 5 a run and only while fewer than 20 are open, changing only machine-made,
  unpinned rows; an episode reflection as `episode`, under the same 20; the main chat and side chats as `user` ("remind me", "that's done"), citing the user's message.
  Episode reflections (`src/dreaming/episodes.ts`) keep them between dreams: after a main-chat or side-chat turn busy
  enough for a skill review, or once 6 of the user's messages came since the last pass, ky forks the chat when it is
  idle and asks the fork, on the background model, what is still open, with the messages since the last pass and their ids.
  The fork may call only `anticipate` and `memory_recall`, is told to answer [SILENT] when nothing is open, and shows in
  Activity as "Episode reflection" ("Nothing open" when silent). Its review row (`ky_skill_reviews`, kind `episode`)
  records the chat entry it forked at, so the count of messages since the last pass needs no state of its own.
  Status moves only forward (open, surfaced, then done, dismissed or expired). A loop closed as done becomes one memory
  with its outcome. The dream expires rows whose window passed unseen, and reads the open ones in its digest.
  Turn-start recall will read them with `match`; no panel shows them yet.
- The morning brief: up to 3 lines for the user's day in `ky_brief` (`src/dreaming/brief.ts`), one row per local
  day, gone at their midnight. The dream writes them with the `anticipate` tool's brief action from what is `due`
  and open (a line from an anticipation marks it surfaced); events may `append` lines too. The first browser hello
  of the day gets a `brief` frame, shown as a card above the chat, not a chat message. Each line shown, and its
  outcome (acted, pinned, dismissed, or expired at midnight), is a `ky_surfaced` row (`src/dreaming/surfaced.ts`);
  the dream's digest reads last week's counts and dismissed lines, and the cap drops to 2 after two weeks in a row
  under 25% acted or pinned. Settings › Proactivity (`ky_proactivity`, `src/dreaming/proactivity.ts`) turns it off.
- Side chats: extra conversations with the main agent's model and memory (`src/chats.ts`).
- Cloud subagents: child conversations the main agent spawns, steers and stops (`subagent` tool, `src/skills/subagents.ts`). Each shows in Activity, and you can open its transcript.
- Specialists: standing bots the user or ky makes, each with an id you @, a one-line description, a brief (its
  persona and standing instructions), and optionally its own model and machine (`specialist` tool, `src/skills/specialists.ts`).
  In the main chat or a side chat, typing `@` offers the specialists; a message that starts with `@id` (up to 3 ids)
  goes to them, and each posts its own reply in the chat under its name and blob: ky doesn't paraphrase it
  (`src/peers/group.ts`). A chat with specialists as members (the topbar's member button) is a group chat: a message with
  no `@` goes through one routing call on the background model, which picks 0 to 3 members by their descriptions;
  when it picks none, ky answers. Only the user's message from the socket is routed. The user's message and each reply
  are passive entries that start no run, and each specialist answers in its own seat for that chat, which has no
  `subagent` tool and a 4-minute budget, so replies never set off more replies. A message's operation id decides it
  once, and every write carries a request id, so a resend posts once. docs/group-chat-routing.md has the rules and the
  research behind them. ky also asks a specialist itself with `subagent ask`, and reports its answer.
  Each specialist keeps one home conversation across ky's asks, so it remembers earlier work. Its brief is versioned like
  SOUL.md (same table, numbered per file): edits apply at once, and history and revert are in the Soul tab, where you
  also add specialists and set their model and machine. Specialists share ky's skills and tools, search memory but
  never write it, and can't edit SOUL.md or specialists. A specialist may consult a peer (up to 3 asks per task;
  the consult runs in a fresh conversation that can't ask on, shown as "@a → @b" in Activity). `subagent discuss`
  puts 2 to 4 specialists through 1 or 2 rounds without tools, and ky gives you where they agree, where they
  disagree, and its recommendation.
- Avatars: bloubs, small animated characters for ky or a specialist (`avatar` tool, `src/avatars.ts`). A model fills a
  spec from a fixed set of parts (body size, corner and colour, one or two eyes, a top, cheeks, feet;
  `src/avatar-spec.ts`); the server checks and clamps it and the page draws it (`src/ui/Bloub.tsx`, motion in
  `src/ui/bloub-motion.ts`), so a model never writes SVG. `preview` and `roll` show options in the chat to pick from;
  `set` saves one. The built-in `make-avatar` skill (`src/seeds.ts`) is how it designs a good one. ky keeps its blob
  until one is saved; a specialist without one gets a bloub rolled from its id. A bloub breathes and blinks, follows
  the pointer, hops when hovered, squishes and sends a heart when clicked, gets dizzy after five quick pokes, leans
  in while working and droops when its answer failed; with reduced motion it stays still.
- Machines: Claude Code or Codex on a real computer (`machine` tool, `src/machines/machines.ts`).
- Automations: recurring (cron, UTC) or one-off jobs made from chat (`automation` tool, `src/automations/automations.ts`). The Agents SDK `Scheduler` fires each run as a subagent or machine task, which reports to the chat that made it. In Activity you can add, edit, run now, pause, resume, archive and delete them.
- Check-ins: one-offs the dream books (`created_by` `dream`) for something the user asked about with a date still
  ahead, set for that morning in the user's time zone (Cloudflare's `cf.timezone` on their last connection). A run
  is told to search in general terms and to answer `NOTHING_NEW` when it found nothing worth saying; then, or when it
  fails, it only shows in Activity ("Nothing new"). Otherwise its report reaches the main agent, which tells the user
  unless memory shows it already has, and notes what it said. A run may call only `executor_skills`,
  `executor_execute` and `browse` (`checkInGuardExtension`); a dream may only create check-ins and list. At most 2 are
  booked a day and 6 wait at once; Activity's "Check-ins on/off" stops the dream booking them and pauses the waiting
  ones (`src/automations/automations.ts`, `src/dreaming/dreaming.ts`).
- Titles: a small model names chats and tasks (`src/titles.ts`).

## Sign-in

Cloudflare Access signs the owner in, and the Worker checks Access's JWT again on every request
(`src/access.ts`): its signature against the team's keys, ky's app, the team and the emails in
`ACCESS_EMAILS`. Only the paths in `BYPASS` skip it: the runner, pairing and upload routes, which check
their own tokens, and the manifest and icons. `ky deploy` sets up both Access apps and the `ACCESS_*` vars;
for `pnpm run deploy`, set them in `wrangler.local.jsonc` and make the apps yourself. Runners never use it: each machine pairs once and gets its own
machine token, and each task it runs gets a task token for its uploads (`src/runners.ts`). The Vault
keeps a machine token's hash only. For a task token it keeps the hash and the nonce the token is derived
from, with the key in the same storage, so it can derive the token again; task tokens expire a day after
they were last issued.

## Deploy from a checkout

This is how the owner deploys from a checkout; everyone else uses `ky init` (the README's quickstart), which needs none of it.


`wrangler.jsonc` is generic: `FILES` (R2 `ky-files`), `BROWSER`, `LOADER`, `AI` and the `PiAgent` object.
What is yours goes in `wrangler.local.jsonc` (gitignored), which `vite.config.ts` merges over it for
`pnpm start` and `pnpm run deploy`: `VIBEPROXY_ORIGIN` (VibeProxy's address on your
computer, `http://127.0.0.1:8317`) and the `VIBEPROXY` VPC service of your tunnel. Copy
`wrangler.local.example.jsonc` to start. Secrets are listed in `.dev.vars.example`; none is required. VibeProxy shows as "Not set up" in Settings until its config and secret are
there, and ky runs without it. Executor is connected in Settings › Tools › Executor, with its URL and a token.

For self-edits, set ky's repo (`owner/name`) in Settings › Self-edits, from the address ky answers on:
setting it also saves that page's origin as ky's address, shown under it. Until then the system prompt
(`src/prompt.ts`) leaves self-edits out.

A merged self-edit deploys through `.github/workflows/deploy.yml`: `pnpm compile linux-x64`, then `ky deploy` with
the overlay from the `KY_OVERLAY` secret and the `CLOUDFLARE_API_TOKEN` secret (the README's "Changing itself").
Without both, it deploys nothing.

```sh
pnpm install
cp wrangler.local.example.jsonc wrangler.local.jsonc   # then fill in what you use
npx wrangler r2 bucket create ky-files
npx wrangler secret put VIBEPROXY_KEY     # VibeProxy's x-api-key on the Mac
pnpm run deploy                           # vite build && wrangler deploy
```

For Claude, run VibeProxy on the Mac at `VIBEPROXY_ORIGIN` and a cloudflared tunnel to it with no public
hostname, then point the `VIBEPROXY` VPC service at that tunnel. Without it ky runs on a vendor whose API key
you added in Settings, else on Workers AI.
Open pages reload by themselves after a deploy (`CF_VERSION_METADATA`), unless you have a draft.

**Models.** Settings picks a model for each of four purposes (`src/settings.ts`): main; worker (subagents,
specialists, automations); background (titles, memory summaries, dreams, skill reviews); and fallback. Each
provider is a row in `ky_providers`, made live by its module in `src/providers/`. `src/models.ts` owns the
one pi registry, the catalog, the defaults and `resolve(purpose, need)`, the only way a model is picked.
Each call checks its provider as it starts (VibeProxy's probe, and a breaker that opens on 401/402/429/5xx);
a call whose provider is down runs on another provider that is healthy then. Claude can be picked only
while VibeProxy answers.
The system prompt is `src/prompt.ts`.

**Deploy order when the runner protocol changes.** Deploy the worker first, then update and restart the
runner on every machine (`ky upgrade`, which restarts the runner service, or `brew upgrade ky`). An old runner is refused with close
code 1008 and keeps retrying, with the reason in its log, until it is updated. A new runner against an old
worker leaves tasks queued without an error, so never update the runner first.

## Machines in depth

Needs `ky` (the release binary, or `pnpm ky` in a checkout), and `claude` or `codex` (or both) installed and
signed in on that machine. macOS and Linux.

Pair it once: in ky, Settings → Machines → Add a machine shows a code good for ten minutes. On the
machine, run the command it shows:

```sh
ky runner add https://ky.<account>.workers.dev <code>
```

It finds the machine's `claude` and `codex` logins, Chrome, the folders holding git repositories, and local
model servers (VibeProxy on 8317, Ollama on 11434), and asks before sharing each (`--yes` shares what it found,
but never Chrome). It keeps the machine token in `~/.config/ky/runner-token` (0600), writes the rest to
`~/.config/ky/runner.json`, installs a launchd agent (`dev.ky.runner`) or a `systemd --user` unit (`ky-runner`, with linger), and waits until ky shows
the machine online. `--no-service` skips the service; run `ky runner run` yourself. A runner paired before
ky kept the token in the file has it in the Keychain (service `ky runner`), which runner.json names: it is read
from there until the next `ky runner add` moves it, which prints the `security delete-generic-password` that
removes the old item. Each `ky runner add` writes the service file fresh, with the ky Homebrew keeps across
upgrades (`/opt/homebrew/bin/ky`, not the Cellar path).

| Command | What it does |
| --- | --- |
| `ky runner add [url code]` | Pair this computer, keep its settings and start its service |
| `ky runner run` | The runner itself, in the foreground (what the service runs) |
| `ky runner ls` | This computer's runner and whether it's online |
| `ky runner status [--json]` | Its settings, token store, service and status |
| `ky runner logs [-f]` | Its log, `~/.ky/runner.log` |
| `ky runner rm` | Stop and remove the service, the token and the settings; then Remove the machine in ky |
| `ky attach <file> [caption]`, `ky diff [base]` | Run by a task, to share a file or its changes |

`ky upgrade` restarts the runner service, so it runs the new release.

Remove in the same list revokes the token: the runner exits and says to pair again. Each task's
agent, `claude` or `codex`, gets only `KY_URL`, `KY_TASK` and `KY_TASK_TOKEN` from ky, never the machine
token; it still runs as your user, so it could read the token file.

Each variable below overrides `runner.json` for `ky runner run`; without `runner.json`, `KY_URL` is required.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KY_URL` | `runner.json` | The deployed Worker |
| `KY_RUNNER_TOKEN_FILE` | `~/.config/ky/runner-token` | The machine token from pairing, in a file; refused unless only you can read it |
| `KY_MACHINE` | host name | Name the agent uses for this machine (`[a-z0-9-]`, 32 chars) |
| `KY_WORKDIR` | `~/ky-work` | Working directory for tasks |
| `KY_PERMISSION_MODE` | `bypassPermissions` | Claude Code permission mode |
| `KY_CLAUDE` | `claude` | Path to the Claude Code executable |
| `KY_CODEX` | `codex` | Path to the Codex executable |
| `CODEX_HOME` | `~/.codex` | The machine's Codex home, whose `auth.json` (from `codex login`) every Codex task signs in with |
| `KY_CHROME` | off | `1`: tasks drive your Chrome with its logins (`--chrome`) |
| `KY_REPOS` | `KY_WORKDIR` | Folders, split by `:`, whose git repositories the runner tells ky about (each folder, and the folders right inside it) |
| `KY_STATE_DIR` | `~/.ky` | Where the runner keeps `handled-<machine>.json`, the commands it already handled, and `codex/<task>`, each Codex task's own `CODEX_HOME`, deleted 14 days after its last turn. Delete it after resetting the object |

`bypassPermissions` lets a task run any command as your user without asking. Run the runner as a
separate user, in a VM, or with `KY_PERMISSION_MODE=acceptEdits` if that is too much.

How a task runs: a task runs as the agent the `machine` tool asked for, or the one the machine has,
Claude Code first (one signed in before one that is not), and keeps it; a machine without that agent installed
refuses it, and one signed out as it last said runs it anyway, so the CLI's own error is the result. A
Claude Code task is one `claude -p` session in stream-json mode. A message sent while it works steers it;
one sent after it finished resumes it with `--resume`. A Codex task is one `codex exec --json` per turn,
in its own `CODEX_HOME` (`KY_STATE_DIR/codex/<task>`) whose `auth.json` links to the machine's, so none of
your Codex config (`config.toml`: models, MCP servers, profiles) or history comes in; its commands get the
runner's whole environment, which Codex would otherwise strip of `*TOKEN*` names, so `ky attach` works. A
home not used for 14 days is deleted, and a later follow-up to that task fails. A message sent while it works
waits for the turn to end; each follow-up resumes the thread with `codex exec resume`. Stop sends SIGINT, then SIGKILL after 5s. Commands wait in `ky_machine_inbox` until the runner acks them, so work sent while the machine is
offline starts when it reconnects. Tasks share files with `ky attach <file> [caption]` (the runner puts a `ky`
on each task's PATH, in `~/.ky/bin`), which uploads to `/api/files`. `ky diff [base]` uploads
the repository's changes as one `text/x-diff` patch (up to 2 MB); the task shows them as a diff, and line
comments on it go back to the task as one message.

**Choosing a machine.** Settings lists every machine with a switch and a note. `On` takes new tasks,
`Paused` finishes its tasks and takes their follow-ups but no new ones, and `Off` takes nothing from the agent.
The note says what the machine is for ("builds and long jobs"). The agent can set both too, when you ask it.
Each runner says in its `hello` what the machine is: its OS, whether `KY_CHROME` is on, and the git repos
in `KY_REPOS` with their `origin` remotes, credentials removed. The agent reads all of it in `machine list`,
and chooses among the machines that are on; the tool refuses the rest. With one machine on and online, a
task goes there; with several, the agent has to name one. A task sent to an offline machine waits for it,
and `move` sends it to another machine that runs its agent, as long as it has not started. Once it has run, its
session lives on that machine, so it stays there.

The runner protocol (the `run`/`stop`/`creds` commands, `hello`/`ack`/`session`/`step`/`result` reports, and the
`http_*` frames for a machine's ports) is shared in `src/machines/runner-protocol.ts` and decoded with typebox at both ends.
`hello` carries `PROTOCOL`, the runner's version and its machine facts (OS, Chrome, repos, which agents are
installed and signed in, shared ports, computer or cloud). The runner says hello before anything it made offline,
and the object reads `protocol` first: a runner on `/runner/<machine>` that speaks another protocol is told `goodbye`
with the one ky speaks, its socket closes with 4426, and it exits. A machine is listed once its runner says a valid hello. A `step` is one tool
the agent used, labelled ("Editing tasks.ts"; a Codex command or file change reads as Bash, Write or Edit), or what it said between tools; a `result` carries the agent and the
session's turns and cost so far. Every report carries its turn, and reports for a closed turn are dropped. The runner records a command
before acking it, so a command never runs twice. One socket per machine: a newer runner with the same
name closes the older one (code 4409), and the older one exits. `cli/runner/runner.ts` is the logic and
`cli/runner/run.ts` the process.
