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
| OpenCode Go | The cheap model (`KY_MODEL`), and the stand-in while the Mac is away. | `src/server.ts` |
| VibeProxy on the Mac | Claude, reached only through the `VIBEPROXY` Workers VPC service over a cloudflared tunnel with no public hostname. Probed on demand with a 30 s cache; when down, turns on Claude go to the fallback slot. | `src/vibeproxy.ts`, `vpc_services` in `wrangler.jsonc` |
| ky-runner on the Mac | Dials out to the DO and runs each machine task as a `claude -p` session. Nothing listens on a port. | `runner/ky-runner.ts` |

**SQLite tables in the DO.** pi's own conversation store, plus:
`ky_tasks` (task feed, `src/tasks.ts`), `ky_machine_inbox` and `ky_machines` (`src/machines.ts`),
`ky_chats` (side chats, `src/chats.ts`), `ky_settings` (model slots, `src/settings.ts`),
`memo_log` and `memo_tree` (memory, `src/memory.ts`), `ky_files` (`src/files.ts`), and the workspace files.

**What the agent can do.**
- Memory: a port of [OptMem](https://github.com/VictorTaelin/OptMem) (`memory_note`, `memory_nap`, `memory_recall`, `memory_zoom`, `memory_forget`), shared by the main chat and its side chats.
- Side chats: extra conversations with the main agent's model and memory (`src/chats.ts`).
- Cloud subagents: child conversations the main agent spawns, steers and stops (`subagent` tool, `src/subagents.ts`). Each shows in Activity, and you can open its transcript.
- Machines: Claude Code on a real computer (`machine` tool, `src/machines.ts`).
- Titles: a small model names chats and tasks (`src/titles.ts`).

## Sign-in

Every request needs the `KY_TOKEN` secret (`src/auth.ts`). The browser signs in once at `/login` and
gets an HttpOnly cookie for a year. A runner sends the same token as `Authorization: Bearer`.

## Setup and deploy

Bindings and vars are in `wrangler.jsonc`: `FILES` (R2 `ky-files`), `BROWSER`, `LOADER`, `VIBEPROXY`
(the VPC service id of your tunnel), `EXECUTOR_URL` and `KY_MODEL`.

```sh
pnpm install
npx wrangler r2 bucket create ky-files
npx wrangler secret put KY_TOKEN          # the one sign-in secret
npx wrangler secret put EXECUTOR_TOKEN    # an Executor personal access token
npx wrangler secret put OPENCODE_API_KEY  # OpenCode Go
npx wrangler secret put VIBEPROXY_KEY     # VibeProxy's x-api-key on the Mac
pnpm run deploy                           # vite build && wrangler deploy
```

For Claude, run VibeProxy on the Mac at `127.0.0.1:8317` and a cloudflared tunnel to it with no public
hostname, then point the `VIBEPROXY` VPC service at that tunnel. Without it ky runs on OpenCode Go.
Open pages reload by themselves after a deploy (`CF_VERSION_METADATA`), unless you have a draft.

**Models.** Settings has four slots (`src/settings.ts`): main, subagents, fallback (Claude's stand-in
while the Mac is away) and titles. Claude can be picked only while VibeProxy answers. The model catalog
and defaults live in `src/server.ts` today; this branch is moving them, with the prompt, into their own
modules.

## Run a machine

Needs Node 22.6 or later (the runner is TypeScript run directly; before Node 23.6 that takes
`--experimental-strip-types`), and `claude` installed and signed in on that machine.

```sh
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

`bypassPermissions` lets a task run any command as your user without asking. Run the runner as a
separate user, in a VM, or with `KY_PERMISSION_MODE=acceptEdits` if that is too much.

How a task runs: each task is one `claude -p` session in stream-json mode. A message sent while it works
steers it; one sent after it finished resumes it with `--resume`; stop sends SIGINT, then SIGKILL after
5s. Commands wait in `ky_machine_inbox` until the runner acks them, so work sent while the machine is
offline starts when it reconnects. Tasks share files with `ky-attach <file> [caption]`, which the runner
installs in `~/.ky/bin` and which uploads to `/api/files`.

The runner protocol (the `run`/`stop` commands and `hello`/`ack`/`session`/`progress`/`result` reports)
is being reworked on this branch for ordered, fenced, durable delivery. Until that lands, its message
types are copied in `runner/ky-runner.ts` and `src/machines.ts`.

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
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest in the Workers pool (`src/tests/`, config `src/tests/vitest.config.ts`) |
| `pnpm lint` | oxlint with [anti-slop](https://github.com/dmmulroy/anti-slop), vendored in `tools/oxlint/anti-slop` (upstream commit in `UPSTREAM`) |
| `pnpm types` | regenerate `env.d.ts` from `wrangler.jsonc` |
