# ky

A personal agent that lives in one Cloudflare Durable Object and answers in any
browser. It is built on Pi Durable (`agents/harness/pi`, `@earendil-works/pi-durable`).
One user, one secret, one object.

## Where things run

```
browser ──wss /agents/pi-agent/me?session=<id>──┐
                                                ├─ Worker ── PiAgent DO "me" (SQLite)
Mac: ky-runner ──wss /runner/<name>─────────────┘      │
                                                       ├─ LOADER   exec sandbox (Dynamic Workers)
                                                       ├─ BROWSER  Kitesurf browser (browse tool)
                                                       ├─ FILES    R2 bucket ky-files
                                                       ├─ Executor MCP (HTTPS)
                                                       ├─ OpenCode Go (HTTPS)
                                                       └─ VIBEPROXY VPC service ── tunnel ── Mac: VibeProxy 127.0.0.1:8317
```

| Piece | What it does | Where |
| --- | --- | --- |
| Worker | Signs the user in, serves the UI assets, stores uploads in R2, routes WebSockets to the DO. | `src/server.ts` (default export), `src/auth.ts`, `src/files.ts` |
| `PiAgent` DO, named `"me"` | The agent: pi conversations, tools, the task feed, machines, settings. Everything is in its SQLite. | `src/server.ts` (`PiAgent`), `src/sockets.ts` |
| Browser UI | React app; one WebSocket per open chat, rebuilt from a snapshot on reconnect. | `src/client.tsx`, `src/ui/*`, `src/use-pi-session.ts` |
| exec sandbox | `exec` runs JavaScript in a fresh Dynamic Worker over the DO's workspace (`/workspace`). No network except git over HTTPS, no shell or npm. | `src/workspace.ts`, binding `LOADER` |
| Kitesurf browser | `browse` opens a cloud page, runs steps, reads it, closes it. No logins. Subagents only; the main agent delegates it. | `src/browse.ts`, binding `BROWSER` |
| R2 `ky-files` | Screenshots and recordings that machine tasks share (25 MB cap). | `src/files.ts`, binding `FILES` |
| Executor | The user's connected apps over MCP (`executor_skills`, `executor_execute`, `executor_resume`). | `src/executor.ts`, var `EXECUTOR_URL` in `wrangler.local.jsonc` |
| Workers AI | Models every deploy has, with no key: GLM 5.3 Flash, Kimi K2.6 and GPT OSS 120B, through AI Gateway's default gateway. The background model, and main's when nothing better is connected. | `src/providers/workers-ai.ts`, binding `AI` |
| OpenCode Go | A model vendor paid with a key; main's model when the `OPENCODE_API_KEY` secret is set. | `src/providers/api-key.ts` |
| VibeProxy on the Mac | Claude, reached only through the `VIBEPROXY` Workers VPC service over a cloudflared tunnel with no public hostname. Probed on demand with a 30 s cache; when down, its calls run on a stand-in on another provider. | `src/providers/vibeproxy.ts`, `vpc_services` in `wrangler.local.jsonc` |
| ky-runner on the Mac | Dials out to the DO and runs each machine task as a Claude Code (`claude -p`) or Codex (`codex exec`) session. Nothing listens on a port. | `runner/ky-runner.ts` |

**SQLite tables in the DO.** pi's own conversation store, plus:
`ky_tasks` (task feed, `src/tasks.ts`), `ky_machine_inbox`, `ky_machines` and `ky_machine_turns` (`src/machines.ts`),
`ky_chats` (side chats, `src/chats.ts`), `ky_automations` (`src/automations.ts`), `ky_providers` (`src/providers/records.ts`),
`ky_purposes` (each purpose's model, `src/settings.ts`),
`memo_log` and `memo_tree` (memory, `src/memory.ts`), `ky_skills`, `ky_skill_versions` and `ky_skill_reviews` (`src/skills.ts`),
`ky_dream` (`src/dreaming.ts`), `ky_files` (`src/files.ts`), and the workspace files.

**What the agent can do.**
- Memory: a port of [OptMem](https://github.com/VictorTaelin/OptMem) (`memory_note`, `memory_recall`, `memory_zoom`, `memory_forget`), shared by the main chat and its side chats. Summaries are written in the background on the main model. `chat_search` finds any message of the main chat and the side chats.
- Skills: procedures the agent writes for itself, after Hermes Agent (`skill_view`, `skill_manage`, `src/skills.ts`).
  Every conversation sees the list. After a main-chat or side-chat turn with 5 or more tool calls, ky forks the
  conversation and asks the fork to update skills; it shows in Activity as "Skill review", and can call only the
  skill tools. Writes apply at once and every one is kept as a version, so `revert` undoes it. Memory holds facts;
  skills hold how to do a kind of task. The panel's Skills tab lists them, with edit, history, revert and archive
  (`src/ui/Skills.tsx`). Machines can't see skills, so ky opens the matching one and puts its steps in the task.
  A review fork keeps the memory its chat was shown and may search it (`memory_recall`, `memory_zoom`), but not write it.
  Each skill keeps when it was last opened, and each version the conversation that made it.
- Dreaming: once a night (04:00 UTC, booked on the automations Scheduler), ky reads what happened since the last
  dream (new memories, skill changes, skill use, finished tasks) in a fresh conversation that wakes with memory, and
  tends the skills: creates one for a task that keeps coming up, merges overlaps, archives ones unused for 60 days,
  and fixes ones a later correction contradicts (`src/dreaming.ts`). It may call only the skill tools and memory's;
  it keeps to OptMem's rules, so it never edits the log: it corrects a memory with a new note plus `memory_forget`
  on the stale summary, is told to note at most five, and pays the compressions its notes make due. It shows in Activity as
  "Dreaming", and skips the night when nothing happened.
- Side chats: extra conversations with the main agent's model and memory (`src/chats.ts`).
- Cloud subagents: child conversations the main agent spawns, steers and stops (`subagent` tool, `src/subagents.ts`). Each shows in Activity, and you can open its transcript.
- Specialists: standing bots the user or ky makes, each with an id you @, a one-line description, a brief (its
  persona and standing instructions), and optionally its own model and machine (`specialist` tool, `src/specialists.ts`).
  `@id message` in the main chat or a side chat goes to that specialist; ky also asks one itself with `subagent ask`.
  Each specialist keeps one home conversation across asks, so it remembers earlier work. Its brief is versioned like
  SOUL.md (same table, numbered per file): edits apply at once, and history and revert are in the Soul tab, where you
  also add specialists and set their model and machine. Specialists share ky's skills and tools, search memory but
  never write it, and can't edit SOUL.md or specialists. A specialist may consult a peer (up to 3 asks per task;
  the consult runs in a fresh conversation that can't ask on, shown as "@a → @b" in Activity). `subagent discuss`
  puts 2 to 4 specialists through 1 or 2 rounds without tools, and ky gives you where they agree, where they
  disagree, and its recommendation.
- Machines: Claude Code or Codex on a real computer (`machine` tool, `src/machines.ts`).
- Automations: recurring (cron, UTC) or one-off jobs made from chat (`automation` tool, `src/automations.ts`). The Agents SDK `Scheduler` fires each run as a subagent or machine task, which reports to the chat that made it. In Activity you can add, edit, run now, pause, resume, archive and delete them.
- Titles: a small model names chats and tasks (`src/titles.ts`).

## Sign-in

Every request needs the `KY_TOKEN` secret (`src/auth.ts`). The browser signs in once at `/login` and
gets an HttpOnly cookie for a year. Runners never use it: each machine pairs once and gets its own
machine token, and each task it runs gets a task token for its uploads (`src/runners.ts`). The Vault
keeps a machine token's hash only. For a task token it keeps the hash and the nonce the token is derived
from, with the key in the same storage, so it can derive the token again; task tokens expire a day after
they were last issued.

## Setup and deploy

`wrangler.jsonc` is generic: `FILES` (R2 `ky-files`), `BROWSER`, `LOADER`, `AI` and the `PiAgent` object.
What is yours goes in `wrangler.local.jsonc` (gitignored), which `vite.config.ts` merges over it for
`pnpm start` and `pnpm run deploy`: `EXECUTOR_URL`, `VIBEPROXY_ORIGIN` (VibeProxy's address on your
computer, `http://127.0.0.1:8317`) and the `VIBEPROXY` VPC service of your tunnel. Copy
`wrangler.local.example.jsonc` to start. Secrets are listed in `.dev.vars.example`; only `KY_TOKEN` is
required. Executor and VibeProxy each show as "Not set up" in Settings until their config and secret are
there, and ky runs without them.

For self-edits, set ky's repo (`owner/name`) in Settings › Self-edits, from the address ky answers on:
setting it also saves that page's origin as ky's address, shown under it. Until then the system prompt
(`src/prompt.ts`) leaves self-edits out.

```sh
pnpm install
cp wrangler.local.example.jsonc wrangler.local.jsonc   # then fill in what you use
npx wrangler r2 bucket create ky-files
npx wrangler secret put KY_TOKEN          # the one sign-in secret
npx wrangler secret put EXECUTOR_TOKEN    # an Executor personal access token
npx wrangler secret put OPENCODE_API_KEY  # OpenCode Go
npx wrangler secret put VIBEPROXY_KEY     # VibeProxy's x-api-key on the Mac
pnpm run deploy                           # vite build && wrangler deploy
```

For Claude, run VibeProxy on the Mac at `VIBEPROXY_ORIGIN` and a cloudflared tunnel to it with no public
hostname, then point the `VIBEPROXY` VPC service at that tunnel. Without it ky runs on OpenCode Go when its
key is set, else on Workers AI.
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
runner on every machine (`git pull && pnpm install`, then restart). An old runner is refused with close
code 1008 and keeps retrying, with the reason in its log, until it is updated. A new runner against an old
worker leaves tasks queued without an error, so never update the runner first.

## Run a machine

Needs Node 22.6 or later (the runner is TypeScript run directly; before Node 23.6 that takes
`--experimental-strip-types`), and `claude` or `codex` (or both) installed and signed in on that machine.

The runner imports the shared protocol (`src/runner-protocol.ts`) and `typebox`, so run it from a checkout
of this repo after `pnpm install`.

Pair it once: in ky, Settings → Machines → Add a machine shows a code good for ten minutes. On the
machine, run the command it shows; it writes the machine token to `~/.config/ky/runner-token` (0600).

```sh
pnpm install
KY_MACHINE=mac node --experimental-strip-types runner/pair.ts https://ky.<account>.workers.dev <code>
KY_URL=https://ky.<account>.workers.dev \
KY_MACHINE=mac \
node --experimental-strip-types runner/ky-runner.ts
```

Remove in the same list revokes the token: the runner exits and says to pair again. Each task's
agent, `claude` or `codex`, gets only `KY_URL`, `KY_TASK` and `KY_TASK_TOKEN` from ky, never the machine
token; it still runs as your user, so it could read the token file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KY_URL` | (required) | The deployed Worker |
| `KY_RUNNER_TOKEN_FILE` | `~/.config/ky/runner-token` | The machine token from pairing; refused unless only you can read it |
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
runner's whole environment, which Codex would otherwise strip of `*TOKEN*` names, so `ky-attach` works. A
home not used for 14 days is deleted, and a later follow-up to that task fails. A message sent while it works
waits for the turn to end; each follow-up resumes the thread with `codex exec resume`. Stop sends SIGINT, then SIGKILL after 5s. Commands wait in `ky_machine_inbox` until the runner acks them, so work sent while the machine is
offline starts when it reconnects. Tasks share files with `ky-attach <file> [caption]`, which the runner
installs in `~/.ky/bin` and which uploads to `/api/files`. `ky-diff [base]`, installed beside it, uploads
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
`http_*` frames for a machine's ports) is shared in `src/runner-protocol.ts` and decoded with typebox at both ends.
`hello` carries `PROTOCOL`, the runner's version and its machine facts (OS, Chrome, repos, which agents are
installed and signed in, shared ports, computer or cloud). The runner says hello before anything it made offline,
and the object reads `protocol` first: a runner on `/runner/<machine>` that speaks another protocol is told `goodbye`
with the one ky speaks, its socket closes with 4426, and it exits. A machine is listed once its runner says a valid hello. A `step` is one tool
the agent used, labelled ("Editing tasks.ts"; a Codex command or file change reads as Bash, Write or Edit), or what it said between tools; a `result` carries the agent and the
session's turns and cost so far. Every report carries its turn, and reports for a closed turn are dropped. The runner records a command
before acking it, so a command never runs twice. One socket per machine: a newer runner with the same
name closes the older one (code 4409), and the older one exits. `runner/runner.ts` is the logic and
`runner/ky-runner.ts` the process.

## Develop

```sh
cp .dev.vars.example .dev.vars   # gitignored; set KY_TOKEN=dev
pnpm start   # vite dev with the Worker and DO; sign in at /login with "dev"
```

`BROWSER` and `AI` (and `VIBEPROXY`, with the overlay) are remote bindings, so `pnpm start` needs
`wrangler login`. Without `wrangler.local.jsonc`, VibeProxy and Executor show as "Not set up". Without
`OPENCODE_API_KEY` and VibeProxy, turns fail with "Provider is not configured"; the UI still works.

| Script | Runs |
| --- | --- |
| `pnpm start` | `vite dev` |
| `pnpm build` | `vite build` |
| `pnpm run deploy` | `vite build && wrangler deploy` |
| `pnpm typecheck` | `tsc --noEmit`, then `tsconfig.node.json` (the runner and the test harnesses) |
| `pnpm test` | worker e2e: vitest in the Workers pool on the real `PiAgent`, fakes only at the edge (`src/tests/`) |
| `pnpm stack` | the local stack: the app with fake Executor, VibeProxy and models (`test/stack/`) |
| `pnpm harness` | CLI scenarios against the local stack with the real runner and fake `claude` and `codex` (`test/harness/`) |
| `pnpm test:node` | vitest in Node on the build's config, such as the owner overlay merge (`test/node/`) |
| `pnpm test:web` | Playwright over the local stack (`test/web/`) |
| `pnpm gate` | typecheck, lint, fallow, node, worker e2e, harness, web; fails if any check in `gate-baseline.json` regresses |
| `pnpm gate:live` | the checks that need the deployed app and the Mac |
| `pnpm lint` | oxlint with [anti-slop](https://github.com/dmmulroy/anti-slop), vendored in `tools/oxlint/anti-slop` (upstream commit in `UPSTREAM`) |
| `pnpm types` | regenerate `env.d.ts` from `wrangler.jsonc` and `.dev.vars.example`; optional config is typed in `env.optional.d.ts` |

`FEATURES.md` lists every feature with the check that covers it. `FUTURE.md` lists what comes next.
