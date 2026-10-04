# ky

A personal agent that lives in one Cloudflare Durable Object and is reachable
from any browser. It is built on Pi Durable (`agents/harness/pi`), started
from Cloudflare's Pi harness example.

- **Main agent.** You talk to it. Claude runs it through VibeProxy while the Mac is online, and OpenCode Go's `KY_MODEL` (DeepSeek V4.1 Flash) otherwise.
- **Memory.** A port of [OptMem](https://github.com/VictorTaelin/OptMem) on the object's SQLite. The agent notes facts with `memory_note`, and older notes fold into summaries (`memory_nap`).
- **Executor.** The user's connected apps, over MCP (`executor_skills`, `executor_execute`, `executor_resume`).
- **Cloud subagents.** Persistent pi conversations that the main agent spawns, steers, stops and resumes (`subagent` tool). Each one shows up in the task feed, and you can open its transcript there.
- **Machines.** Real computers run tasks as Claude Code sessions, with a browser, scripts and local files (`machine` tool). A machine runs `runner/ky-runner.ts`, which dials out to ky, so nothing listens on a port.

```
browser ──wss──┐
               ├── PiAgent DO "me" ── Claude via the Mac, OpenCode Go
runner(s) ─wss─┘        │               Executor MCP
                        └── SQLite: pi sessions, memory, task feed, machine inbox
```

## Sign-in

Every request needs the `KY_TOKEN` secret. The browser signs in once at
`/login` and gets an HttpOnly cookie that lasts a year. A runner sends the
token as `Authorization: Bearer`.

## Run a machine

Requirements: Node 22 or later, and `claude` installed and signed in on that
machine with your own account.

```sh
KY_URL=https://ky.<account>.workers.dev \
KY_TOKEN="$(cat ~/.config/ky/token)" \
KY_MACHINE=mac \
node runner/ky-runner.ts
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `KY_MACHINE` | host name | Name the agent uses for this machine |
| `KY_WORKDIR` | `~/ky-work` | Working directory for tasks |
| `KY_PERMISSION_MODE` | `bypassPermissions` | Claude Code permission mode |
| `KY_CLAUDE` | `claude` | Path to the Claude Code executable |

The default `bypassPermissions` lets a task run any command as your user
without asking. Run the runner as a separate macOS user, in a VM, or with
`KY_PERMISSION_MODE=acceptEdits` if that is too much.

How a task runs:

- Each task is one `claude -p` session in stream-json mode.
- A message sent while the task is working steers it.
- A message sent after it finished resumes the session with `--resume`.
- Stop interrupts it.
- Commands wait in an inbox on the server until the runner acknowledges them, so work sent while the machine is offline starts when it reconnects.

## Develop

```sh
pnpm install
printf 'KY_TOKEN=dev\nEXECUTOR_TOKEN=\n' > .dev.vars
pnpm start          # vite dev; sign in with "dev"
pnpm typecheck && pnpm test && pnpm lint
```

## Deploy

```sh
pnpm run deploy
npx wrangler secret put KY_TOKEN
npx wrangler secret put EXECUTOR_TOKEN   # an Executor personal access token
npx wrangler secret put OPENCODE_API_KEY # OpenCode Go
```

`EXECUTOR_URL` and `KY_MODEL` are vars in `wrangler.jsonc`.

## Models

The panel's Models tab picks the model and thinking level for three slots:
the main agent, the subagents, and the stand-in for Claude while the Mac is
away. Claude can be chosen only while VibeProxy on the Mac answers; OpenCode
Go offers the one model in `KY_MODEL` once `OPENCODE_API_KEY` is set. Without
a choice, the main agent uses Claude when the Mac is online, and everything
else uses `KY_MODEL`.

## Lint

`pnpm lint` runs oxlint with
[anti-slop](https://github.com/dmmulroy/anti-slop). The rules are vendored in
`tools/oxlint/anti-slop`; the upstream commit is in `UPSTREAM`.
