# ky

A personal agent that lives in one Cloudflare Durable Object and answers in any
browser. It is built on Pi Durable (`agents/harness/pi`, `@earendil-works/pi-durable`).
One user, one secret, one object.

## Where things run

```
browser ──wss /agents/pi-agent/me?session=<id>──┐
                                                ├─ Worker ── PiAgent DO "me" (SQLite)
Mac: ky-runner ──wss ...?runner=<name>──────────┘      │
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
| Executor | The user's connected apps over MCP (`executor_skills`, `executor_execute`, `executor_resume`). | `src/executor.ts`, var `EXECUTOR_URL` |
| OpenCode Go | The cheap model (`KY_MODEL`), and the stand-in while the Mac is away. | `src/models.ts` |
| VibeProxy on the Mac | Claude, reached only through the `VIBEPROXY` Workers VPC service over a cloudflared tunnel with no public hostname. Probed on demand with a 30 s cache; when down, turns on Claude go to the fallback slot. | `src/vibeproxy.ts`, `vpc_services` in `wrangler.jsonc` |
| ky-runner on the Mac | Dials out to the DO and runs each machine task as a `claude -p` session. Nothing listens on a port. | `runner/ky-runner.ts` |

**SQLite tables in the DO.** pi's own conversation store, plus:
`ky_tasks` (task feed, `src/tasks.ts`), `ky_machine_inbox`, `ky_machines` and `ky_machine_turns` (`src/machines.ts`),
`ky_chats` (side chats, `src/chats.ts`), `ky_automations` (`src/automations.ts`), `ky_settings` (model slots, `src/settings.ts`),
`memo_log` and `memo_tree` (memory, `src/memory.ts`), `ky_skills`, `ky_skill_versions` and `ky_skill_reviews` (`src/skills.ts`), `ky_files` (`src/files.ts`), and the workspace files.

**What the agent can do.**
- Memory: a port of [OptMem](https://github.com/VictorTaelin/OptMem) (`memory_note`, `memory_nap`, `memory_recall`, `memory_zoom`, `memory_forget`), shared by the main chat and its side chats.
- Skills: procedures the agent writes for itself, after Hermes Agent (`skill_view`, `skill_manage`, `src/skills.ts`).
  Every conversation sees the list. After a main-chat or side-chat turn with 5 or more tool calls, ky forks the
  conversation and asks the fork to update skills; it shows in Activity as "Skill review", and can call only the
  skill tools. Writes apply at once and every one is kept as a version, so `revert` undoes it. Memory holds facts;
  skills hold how to do a kind of task. The panel's Skills tab lists them, with edit, history, revert and archive
  (`src/ui/Skills.tsx`). Machines can't see skills, so ky opens the matching one and puts its steps in the task.
- Side chats: extra conversations with the main agent's model and memory (`src/chats.ts`).
- Cloud subagents: child conversations the main agent spawns, steers and stops (`subagent` tool, `src/subagents.ts`). Each shows in Activity, and you can open its transcript.
- Machines: Claude Code on a real computer (`machine` tool, `src/machines.ts`).
- Automations: recurring (cron, UTC) or one-off jobs made from chat (`automation` tool, `src/automations.ts`). The Agents SDK `Scheduler` fires each run as a subagent or machine task, which reports to the chat that made it. In Activity you can add, edit, run now, pause, resume, archive and delete them.
- Titles: a small model names chats and tasks (`src/titles.ts`).

## Sign-in

Every request needs the `KY_TOKEN` secret (`src/auth.ts`). The browser signs in once at `/login` and
gets an HttpOnly cookie for a year. A runner sends the same token as `Authorization: Bearer`.

## Setup and deploy

Bindings and vars are in `wrangler.jsonc`: `FILES` (R2 `ky-files`), `BROWSER`, `LOADER`, `VIBEPROXY`
(the VPC service id of your tunnel), `EXECUTOR_URL`, `KY_MODEL`, `VIBEPROXY_ORIGIN` (VibeProxy's address on
the Mac, `http://127.0.0.1:8317`), and `KY_REPO`, `KY_WORK_COPY` and `KY_URL` (where ky's own code lives, for
self-edits in `src/prompt.ts`).

```sh
pnpm install
npx wrangler r2 bucket create ky-files
npx wrangler secret put KY_TOKEN          # the one sign-in secret
npx wrangler secret put EXECUTOR_TOKEN    # an Executor personal access token
npx wrangler secret put OPENCODE_API_KEY  # OpenCode Go
npx wrangler secret put VIBEPROXY_KEY     # VibeProxy's x-api-key on the Mac
pnpm run deploy                           # vite build && wrangler deploy
```

For Claude, run VibeProxy on the Mac at `VIBEPROXY_ORIGIN` and a cloudflared tunnel to it with no public
hostname, then point the `VIBEPROXY` VPC service at that tunnel. Without it ky runs on OpenCode Go.
Open pages reload by themselves after a deploy (`CF_VERSION_METADATA`), unless you have a draft.

**Models.** Settings has four slots (`src/settings.ts`): main, subagents, fallback (Claude's stand-in
while the Mac is away) and titles. Claude can be picked only while VibeProxy answers. `src/models.ts` owns
the catalog, the defaults, `resolve(slot)` and the fallback; `src/vibeproxy.ts` makes one provider per tunnel.
The system prompt is `src/prompt.ts`.

**Deploy order when the runner protocol changes.** Deploy the worker first, then update and restart the
runner on every machine (`git pull && pnpm install`, then restart). An old runner is refused with close
code 1008 and keeps retrying, with the reason in its log, until it is updated. A new runner against an old
worker leaves tasks queued without an error, so never update the runner first.

## Run a machine

Needs Node 22.6 or later (the runner is TypeScript run directly; before Node 23.6 that takes
`--experimental-strip-types`), and `claude` installed and signed in on that machine.

The runner imports the shared protocol (`src/runner-protocol.ts`) and `typebox`, so run it from a checkout
of this repo after `pnpm install`.

```sh
pnpm install
KY_URL=https://ky.<account>.workers.dev \
KY_TOKEN_FILE=~/.config/ky/token \
KY_MACHINE=mac \
node --experimental-strip-types runner/ky-runner.ts
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `KY_URL` | (required) | The deployed Worker |
| `KY_TOKEN` / `KY_TOKEN_FILE` | (one required) | `KY_TOKEN`, inline or read from a file |
| `KY_MACHINE` | host name | Name the agent uses for this machine (`[a-z0-9-]`, 32 chars) |
| `KY_WORKDIR` | `~/ky-work` | Working directory for tasks |
| `KY_PERMISSION_MODE` | `bypassPermissions` | Claude Code permission mode |
| `KY_CLAUDE` | `claude` | Path to the Claude Code executable |
| `KY_CHROME` | off | `1`: tasks drive your Chrome with its logins (`--chrome`) |
| `KY_REPOS` | `KY_WORKDIR` | Folders, split by `:`, whose git repositories the runner tells ky about (each folder, and the folders right inside it) |
| `KY_STATE_DIR` | `~/.ky` | Where the runner keeps `handled-<machine>.json`, the commands it already handled. Delete it after resetting the object |

`bypassPermissions` lets a task run any command as your user without asking. Run the runner as a
separate user, in a VM, or with `KY_PERMISSION_MODE=acceptEdits` if that is too much.

How a task runs: each task is one `claude -p` session in stream-json mode. A message sent while it works
steers it; one sent after it finished resumes it with `--resume`; stop sends SIGINT, then SIGKILL after
5s. Commands wait in `ky_machine_inbox` until the runner acks them, so work sent while the machine is
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
and `move` sends it to another machine as long as it has not started. Once it has run, its Claude Code session
lives on that machine, so it stays there.

The runner protocol (the `run`/`stop` commands and `hello`/`ack`/`session`/`step`/`result` reports)
is shared in `src/runner-protocol.ts` and decoded with typebox at both ends. `hello`'s machine facts are
optional, so a runner and a worker from either side of that change still work together. A `step` is one tool Claude
Code used, labelled ("Editing tasks.ts"), or what it said between tools; a `result` carries the session's
turns and cost so far. `hello` carries `PROTOCOL`;
every report carries its turn, and reports for a closed turn are dropped. The runner records a command
before acking it, so a command never runs twice. One socket per machine: a newer runner with the same
name closes the older one (code 4409), and the older one exits. `runner/runner.ts` is the logic and
`runner/ky-runner.ts` the process.

## Develop

```sh
printf 'KY_TOKEN=dev\nEXECUTOR_TOKEN=\n' > .dev.vars   # gitignored
pnpm start   # vite dev with the Worker and DO; sign in at /login with "dev"
```

`BROWSER` and `VIBEPROXY` are remote bindings, so `pnpm start` needs `wrangler login`. Without
`OPENCODE_API_KEY` and VibeProxy, turns fail with "Provider is not configured"; the UI still works.

| Script | Runs |
| --- | --- |
| `pnpm start` | `vite dev` |
| `pnpm build` | `vite build` |
| `pnpm run deploy` | `vite build && wrangler deploy` |
| `pnpm typecheck` | `tsc --noEmit`, then `tsconfig.node.json` (the runner and the test harnesses) |
| `pnpm test` | worker e2e: vitest in the Workers pool on the real `PiAgent`, fakes only at the edge (`src/tests/`) |
| `pnpm stack` | the local stack: the app with fake Executor, VibeProxy and models (`test/stack/`) |
| `pnpm harness` | CLI scenarios against the local stack with the real runner and a fake `claude` (`test/harness/`) |
| `pnpm test:web` | Playwright over the local stack (`test/web/`) |
| `pnpm gate` | typecheck, lint, fallow, worker e2e, harness, web; fails if any check in `gate-baseline.json` regresses |
| `pnpm gate:live` | the checks that need the deployed app and the Mac |
| `pnpm lint` | oxlint with [anti-slop](https://github.com/dmmulroy/anti-slop), vendored in `tools/oxlint/anti-slop` (upstream commit in `UPSTREAM`) |
| `pnpm types` | regenerate `env.d.ts` from `wrangler.jsonc` |

`FEATURES.md` lists every feature with the check that covers it. `FUTURE.md` lists what comes next.
