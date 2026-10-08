# ky: setup, providers, runners, and a cloud machine

Integration branch: `setup-untether`. Rev 3: the full plan as a DAG of nodes.

Each node is built in its own worktree and session, then merged into `setup-untether` by a PR whose title starts
with `[<node id>]`. To start a node, run `scripts/dag.sh start <id>`; `scripts/dag.sh status` shows what's ready.

## Goal

Anyone can run `brew install … && ky init` and be chatting on Cloudflare in minutes, with every primitive working:
- SOUL.md
- memory (optmem, background summaries, chat_search)
- skills and skill reviews, dreaming
- extensions and broadcast
- specialists, subagents, automations
- machine tasks
- browse, workspace, files, images
- the PWA

Specifically:
- **Default models, no keys:** Workers AI through the `AI` binding.
- **More models:** paste an API key (Anthropic, OpenAI, OpenRouter, OpenCode Go).
- **Subscriptions:** ChatGPT and Claude subscriptions run as Codex and Claude Code tasks on machines.
- **Optional add-ons:**
  - computers you own (runners)
  - local models on them (VibeProxy for Claude, Ollama)
  - Executor
- **Works with every computer off.** A cloud machine runs tasks, builds, and ky's own changes.
- **Nothing about the owner is in code.** Yesh's setup is one instance of the general setup, kept in a gitignored
  overlay.

## Rules for every node

1. **Same UI, same stack.** React client, existing components, `styles.css` tokens, existing panels. New screens
   extend Settings and Machines the way they're built today. No new UI libraries, no redesigns. The quality bar
   is the current app.
2. **pi-durable stays the core.** ky's agent loop, memory, skills and tools are untouched except where a node says
   otherwise.
3. **No backward compatibility.** Rename, reshape tables, change the protocol, and drop old paths freely.
4. **`pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm gate` pass before the PR.**
   - FEATURES.md is the acceptance list.
   - When behaviour changes on purpose, update the row in the same PR: rewrite it, retire it with a reason, or add one.
   - No row disappears silently.
5. **Fakes at the boundary only**, in `test/fakes`, the way the harness does today.
   - A node that adds a boundary also adds its fake: Access, AI binding, OAuth device code, container.
6. **Stay in your node's files where you can.** `server.ts` is shared by many nodes, so keep edits there small and
   localized, and rebase on `setup-untether` before opening the PR.
7. **The contracts below are fixed.** A node that needs a contract changed:
   - changes this doc in its PR, and
   - says so in the PR description.
8. **Policy:**
   - No Claude subscription token is ever used outside the real `claude` CLI.
   - pi's Claude OAuth "stealth" path is never used.
   - VibeProxy is an opt-in local model on a runner, and the only route for Claude-in-ky's-chat.

## Where things stand

**Hardcoded config**
- `wrangler.jsonc` ships the owner's values:
  - the VPC `service_id`
  - `EXECUTOR_URL` (org presh)
  - `KY_REPO`, `KY_WORK_COPY`, `KY_URL`
  - `KY_MODEL` (unused by `main`)
- `server.ts:62-74` always builds VibeProxy and OpenCode Go.
- `models.ts:105` sets `kyDefaults` to `vibeproxy/claude-opus-5-5`.
- There is no `ai` binding.

**Models**
- `Models.registry()` (`models.ts:218-229`) rebuilds `createModels` on every call, with no credential store.
- `ask` and `#standIn` (`:185-215`, `:303-314`) resolve keys per call with no `getAuth`.
- Model choice is duplicated across:
  - `settings.ts` slots
  - `subagents.ts:118,142`
  - `automations.ts:516`
  - specialists
  - `images.ts:58`, the composer's early warning, which must keep working
- Memory summaries (`server.ts:93`) and dreams (`server.ts:151`) run on `main`.

**Auth**
- `KY_TOKEN` is the UI password, the cookie and the runner bearer (`auth.ts`).
- `ky-runner.ts:196` puts it into `bypassPermissions` Claude children.
- `files.ts` upload checks no token.

**Runners**
- A runner is identified only by `?runner=` on the browser's own path (`sockets.ts:64`).
- `hello.protocol` is a strict literal (`runner-protocol.ts:76`), and a mismatch is closed as garbage (`sockets.ts:455`).
- The runner is a Node script run from a repo checkout.
- Its only agent is `claude -p`.

**Tethered to the Mac**
- The cloud `exec` is JS-only with no network.
- `prompt.ts:20-21` sends scripts, builds and self-changes to a machine.
- `prompt.ts:26-43` hardwires self-edit and ship to `${workCopy}` on the Mac.
- `machines.ts:740` says every task is a Claude Code session on "the user's real computers".

**Probed facts**

| Thing | Result |
|---|---|
| `chatgpt.com/backend-api/codex` | 403 from Workers; reachable from Containers and the Mac |
| `api.openai.com`, `auth.openai.com`, `api.anthropic.com` | reachable from Workers |
| Workers AI | A custom pi provider over `createAiBindingFetch(env.AI)` through the `default` gateway works with zero config. `glm-5.3-flash` and `kimi-k2.6` did tool round trips. Third-party models return 402 without unified-billing credits. Import from `@earendil-works/pi-ai/models` and register with `setProvider`. The probe code is in the appendix. |

**Scotty mechanisms to port** (`../scotty`)
- `CredsObject` with CAS refresh: `src/creds/object.ts:183-225`.
- ChatGPT device code on the Codex client: `src/creds/oauth.ts`.
- A git smart-HTTP proxy through `interceptOutboundHttp("github.internal")` plus a git `insteadOf`, with pushes
  restricted to a branch prefix: `src/places/cloudflare.ts:16`, `container/supervisor/workspace.ts:153`,
  `src/creds/git.ts`.
- Container keepalive alarm and deadlines: `src/session/deadlines.ts`.
- Workspace save and restore: `container/supervisor/controller.ts:167`, `socket.ts:190`.
- Codex adapter: `container/supervisor/agents/codex/runner.ts`, `config.ts`.
- Deployer: `deploy/deployer.ts` (`putScript`, migrations on first deploy, assets, R2, Access apps, container app).
- Image copy: `deploy/image.ts`.
- Release: `deploy/release.ts`, `compile.ts`, `cli/binary.ts`, `.github/workflows/release.yml`, `install.sh`.
- CLI flows: `cli/commands/init.ts`, `setup.ts`; agent guide: `skills/scotty/SKILL.md`.

## Contracts

These are fixed so nodes can be built in parallel.

### C1. Runner protocol v3 (`src/runner-protocol.ts`, `PROTOCOL = 3`)

**Socket:** `GET /runner/<machine>` (WebSocket upgrade) with `Authorization: Bearer <machine token>`. The path is
outside Access. The Worker checks the token against the Vault and routes the socket to
`PiAgent.getByName("me")` tagged as that machine.

**Object → runner**

| Frame | Fields | Notes |
|---|---|---|
| `run` | `seq, task, turn, prompt, session, agent: "claude"\|"codex", taskToken, creds?` | `creds` is optional per-task credentials: `{ claude?: { oauthToken }, codex?: { accessToken, refreshToken: null, idToken, accountId, expiresAt } }`, `expiresAt` in epoch milliseconds. Absent means use the machine's own login. |
| `stop` | `seq, task, turn` | |
| `creds` | `seq, task, codex` | Mid-task Codex token refresh. |
| `http_request` | `id, port, method, path, headers, body?` | `body` is base64. Only to an allowed port. |
| `http_cancel` | `id` | |
| `goodbye` | `reason, expected?` | Sent before close code 4426 on a protocol mismatch, or 4401 on a revoked token. |

**Runner → object**

| Frame | Fields | Notes |
|---|---|---|
| `hello` | `protocol: integer, version, active, facts` | The server reads `protocol` first, then validates the rest. `facts` = `{ os, chrome, repos, agents: { claude: { installed, signedIn }, codex: { installed, signedIn } }, ports: number[], kind: "computer"\|"cloud" }`. |
| `ack`, `session`, `step`, `result` | as in v2 | `result` gains `agent`. |
| `http_head` | `id, status, headers` | |
| `http_chunk` | `id, data` | `data` is base64. |
| `http_end` | `id` | |
| `http_error` | `id, message` | |

**Child process env:** `KY_URL`, `KY_TASK`, `KY_TASK_TOKEN`, plus the agent's own credential when `creds` was sent
(`CLAUDE_CODE_OAUTH_TOKEN`, or an `auth.json` in a per-task `CODEX_HOME`). The machine token is never in a child's env.

### C2. HTTP routes

| Route | Auth | What it does |
|---|---|---|
| `POST /api/runners/codes` | Access | Returns `{ code, expiresAt }`. 10 minutes, single use. |
| `POST /api/runners/pair` | none | Body `{ code, name, facts }`; returns `{ machine, token }`. Rate limited. |
| `DELETE /api/runners/<machine>` | Access | Revokes the token and closes the socket. |
| `POST /api/files?task=<id>` | `Bearer <taskToken>` | Matched to the task. |
| `GET /runner/<machine>` | `Bearer <machine token>` | The runner socket. |

**Access bypass paths:** `/runner/*`, `/api/runners/pair`, `/api/files`, `/manifest.webmanifest`, `/icons/*`.

### C3. Access (`src/access.ts`)

- **Env:** `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`), `ACCESS_AUD`, `ACCESS_EMAILS` (comma separated).
- **Every non-bypass request and socket upgrade:**
  - Verify `Cf-Access-Jwt-Assertion`: an RS256 signature against `https://<team>/cdn-cgi/access/certs` (keys
    cached), `aud` contains `ACCESS_AUD`, and `exp`/`nbf`.
  - The email must be in `ACCESS_EMAILS`.
  - A bare `cf-access-authenticated-user-email` header is never trusted.
- **Dev:** when `KY_DEV=1`, `KY_DEV_EMAIL` stands in. Set only in local and test configs.
- `KY_TOKEN`, `auth.ts`, the login form and the cookie are deleted.

### C4. Vault (`src/vault.ts`, DO class `Vault`, `getByName("owner")`, SQLite, migration v2)

```ts
// secrets: kind = "provider" | "claude" | "chatgpt" | "github" | "executor"
put(kind, id, value: Json, meta?): void
remove(kind, id): void
status(): { kind, id, meta, updatedAt, error? }[]          // never secrets
auth(providerId): { apiKey: string; headers?: Record<string,string> } | null
sessionCreds(agent: "claude" | "codex"): RunCreds[agent] | null   // refreshes codex with CAS
chatgptLogin(): { userCode, verificationUrl, loginId }; chatgptPoll(loginId): "pending" | "done" | { error }
githubToken(): { token, repos } | null
// tokens: kind = "pair" | "machine" | "task"
mint(kind, subject, ttlMs?): string                          // returns raw once; stores sha-256
check(kind, token): subject | null
revoke(kind, subject): void
```

### C5. Providers and purposes (`src/models.ts` and `src/providers/*`)

- **Provider records** are stored in `ky_providers`:
  `{ id, kind: "workers-ai" | "api-key" | "runner-local", vendor?, machine?, port?, api?, label, enabled }`.
  The credential for an `api-key` record lives in the Vault under `("provider", id)`.
- **Purposes:**

| Purpose | Default |
|---|---|
| `main` | Best connected |
| `worker` (subagents, specialists, automations) | `main` |
| `background` (titles, memory summaries, dreams, skill reviews) | Workers AI, thinking off |
| `fallback` | First healthy model that isn't `main` |

- **API:**
  - `models.resolve(purpose, need?: { tools?, images?, context? })` returns a model and thinking level.
  - It's the only way any caller picks a model.
  - `imageSupport` asks it.

### C6. Owner overlay

- `wrangler.jsonc` is generic.
- `wrangler.local.jsonc` (gitignored) holds the owner's vars, the VPC binding and routes.
- `pnpm deploy` uses it when present; the CLI deployer writes the equivalent for CLI users.

## DAG

```
wave 1   R1 protocol   R2 config   R3 vault-core
           │  │  │       │   │        │  │
wave 2     │  │  X codex │   M models │  │        D cli-deploy (R2)
           │  T runner-auth (R1,R3) ◄──┘  │
wave 3     A access (T)   P pipe (R1,M)   K keys (M,R3)   S subscriptions (R3,T,X)
wave 4     C cli-runner (D,T,P)           F first-run (M,K,S)
wave 5     CM cloud-machine (D,S,C)
wave 6     RT routing+self-edit (CM)      REL release (A,C,CM,D)
```

| Id | Name | Depends on | Size |
|---|---|---|---|
| R1 | protocol-v3 | — | M |
| R2 | config | — | S |
| R3 | vault-core | — | M |
| M | models | R2 | L |
| T | runner-auth | R1, R3 | M |
| X | codex-agent | R1 | M |
| D | cli-deploy | R2 | L |
| A | access | T | M |
| P | runner-pipe | R1, M | M |
| K | vault-keys | M, R3 | S |
| S | subscriptions | R3, T, X | M |
| C | cli-runner | D, T, P | M |
| F | first-run | M, K, S | M |
| CM | cloud-machine | D, S, C | XL |
| RT | routing-self-edit | CM | M |
| REL | release | A, C, CM, D | M |

At most four sessions run at once (wave 2). The longest chain is R1 → T → S → CM → RT.

## Nodes

### R1. protocol-v3
- **Protocol:**
  - Implement C1's schemas in full, including frames nothing uses yet.
  - Set `PROTOCOL = 3`, with `hello.protocol` as an integer.
  - On mismatch, send `goodbye` and close with 4426.
- **Socket path:**
  - Move the runner socket to `GET /runner/<machine>`. The `?runner=` handling in `sockets.ts` goes away.
  - The browser socket path is unchanged.
- **Runner:**
  - Update `runner/ky-runner.ts` to the new path and the v3 `hello`: `version`, and `facts.agents` /
    `facts.ports` (empty for now) / `kind: "computer"`.
  - Agent is always `claude` for now.
  - The runner still authenticates with `KY_TOKEN`; T replaces that.
- **Tests:** update the harness and FEATURES rows `runner-protocol-version` and the socket rows; add a mismatch
  scenario.
- **Done when:** `pnpm gate` is green and a v2-shaped hello gets `goodbye`.

### R2. config
- **wrangler.jsonc:**
  - Remove owner values from it and `server.ts`.
  - Add `"ai": { "binding": "AI" }`.
  - Create the C6 overlay with today's values. `pnpm deploy` and `pnpm start` use it when present. Add it to
    `.gitignore`.
  - Add `.dev.vars.example`.
- **Soft-fail:**
  - Each optional binding and var (`VIBEPROXY`, `VIBEPROXY_ORIGIN`, `EXECUTOR_*`, `OPENCODE_API_KEY`) shows up as
    "not set up".
  - The DO constructor never throws.
  - `boundaryFor` builds VibeProxy and OpenCode Go only when they're configured.
- **Derived values:**
  - `KY_URL` from the request origin, stored the first time it's seen.
  - `KY_REPO` becomes a DO setting.
  - `KY_WORK_COPY` is gone.
- **Prompt:**
  - `prompt.ts` stops naming a Mac.
  - Its self-edit block appears only when a repo setting exists, and is phrased for "a machine that has the repo".
    RT rewrites it later.
- **Done when:**
  - A fresh clone with no overlay runs `pnpm start` and the gate with no owner values.
  - With the overlay, behaviour is today's.

### R3. vault-core
- **Vault DO:** `src/vault.ts`, the `Vault` class, migration v2 in `wrangler.jsonc` and `src/tests/wrangler.jsonc`.
- **Methods:**
  - The C4 secret methods: `put`, `remove`, `status`.
  - Token methods `mint`, `check` and `revoke`, with sha-256 hashes, constant-time compare and expiry.
  - A generic `refresh(kind, id, fn)` CAS helper, ported from Scotty `CredsObject:183-225`.
  - `auth`, `sessionCreds` and `chatgpt*` are stubs that return null or throw "not set up". S and K fill them in.
- **Tests:** worker tests for every method, including concurrent refresh.
- **Done when:** the Vault is tested; there are no callers yet.

### M. models
- **Registry:**
  - One cached `createModels` registry per DO.
  - Every call (`ask`, `complete`, turns, stand-in) goes through `getAuth`/`applyAuth`.
  - The `sessionId` quirk moves into the OpenCode endpoint.
- **Providers (C5):**
  - `providers/workers-ai.ts`: the binding provider from the appendix, with a curated tool-capable default list
    (glm-5.3-flash, kimi-k2.6, gpt-oss-120b).
  - `providers/api-key.ts`, per vendor. Reads env secrets for now; K moves them to the Vault.
  - The `ky_providers` table.
  - The existing VibeProxy and OpenCode endpoints are re-expressed as records, enabled by the overlay.
- **Health:** a circuit breaker on 401/402/429/5xx for every provider; the existing probe for VibeProxy.
- **Resolver:**
  - `resolve(purpose, need)` replaces the slots everywhere: `settings.ts`, subagents, automations, specialists,
    titles, memory, dreams, skill reviews.
  - `imageSupport` is kept and asks the resolver.
  - The stand-in and fallback behaviour "when the model's machine is away" stays, generalized from "Mac" to the
    provider's health.
- **UI:**
  - Settings shows a model per purpose, using the current Settings components.
  - Providers is still read-only; K makes it interactive.
- **FEATURES rows to rewrite:** `slot-store`, `slot-persist`, `title-slot`, `memory-compress`, the dreaming and
  skill-review rows, `ky.spec.ts:212`, `image-standin`.
- **Done when:**
  - A zero-secret deploy chats on Workers AI with tools.
  - Memory, titles, dreams, specialists, automations and subagents all run.
  - The overlay restores VibeProxy for `main`.

### T. runner-auth
- **Routes:** implement C2 using the Vault tokens.
- **Pairing:** `POST /api/runners/codes` and `/pair`.
  - Code from `mint("pair")`, exchanged for `mint("machine", name)`.
  - Revoke closes the live socket with `goodbye` and 4401.
- **Task tokens:** `run` carries `taskToken = mint("task", taskId)`, revoked when the task ends.
- **Uploads:** `/api/files` checks the token. `ky-attach` and `ky-diff` use `KY_TASK_TOKEN`.
- **Runner:**
  - Reads its machine token from `KY_RUNNER_TOKEN_FILE` (default `~/.config/ky/runner-token`, mode 0600).
  - Stops reading `KY_TOKEN`.
  - Its children get only C1's env.
- **UI:** Machines panel gets "Add a machine", which shows the code and the command (`ky runner add <url> <code>`;
  until C exists, a `node runner/pair.ts <url> <code>` helper). It also gets "Remove". Use the current panel's
  look.
- **Done when:** the harness covers pair, run, upload, revoke, an expired code, and a reused code.

### X. codex-agent
- **Adapter:** in the runner, port Scotty's Codex adapter:
  - `codex exec --json` mapped onto `session` / `step` / `result`
  - resume by thread id
  - stop
  - a per-task `CODEX_HOME`
- **Agent choice:**
  - `run.agent` selects the agent.
  - `hello.facts.agents` reports what's installed and signed in (`claude auth status` / `codex login status`, or
    equivalents).
- **Tool and server:**
  - The `machine` tool gains an `agent` parameter, defaulting to whatever the machine has, Claude first.
  - The task row records its agent. `move` keeps the agent.
- **Tests:** a fake `codex` in `test/fakes`, plus harness scenarios: run, follow-up (resume), stop, move.
- **Done when:** with the machine's own `codex login`, a real Codex task runs on the Mac (by hand), and the harness is
  green.

### D. cli-deploy
- **Package:** `cli/`, a Bun-compiled `ky`.
  - Port Scotty's `cli/binary.ts`, `deploy/compile.ts`, `deploy/release.ts`.
  - Embed the release pack: the Worker bundle and assets.
- **Deployer** (port of `deploy/deployer.ts` over `@distilled.cloud/cloudflare`):
  - Script with the C6 bindings; migrations on first deploy only.
  - Assets, R2 bucket, `AI` binding, secrets.
  - Access app plus a bypass app for the C2 paths. Sets `ACCESS_*` (C3).
  - Container app support is left as a hook for CM.
- **Commands:**
  - `ky init`: Cloudflare login (API token or `wrangler login` reuse), account pick, name, owner email, deploy,
    open the URL.
  - `ky deploy`, `ky upgrade`, `ky doctor` (checks each piece and prints the next command).
  - `ky teardown`: the Worker, DO data, R2, Access apps, secrets.
  - `ky skill`: a guide for agents.
- **Done when:** on a clean account, `ky init` ends with ky behind Access (once A lands; before that, with Access
  configured but the Worker's check inert) and chatting on Workers AI.

### A. access
- **Implement C3:** verify the signed token on every non-bypass request and socket upgrade.
- **Remove:** `auth.ts`, `KY_TOKEN`, the login form and the cookie.
- **Client:**
  - When the socket upgrade fails for auth, reload so Access can redirect.
  - Verify the service worker never caches Access's pages.
  - The manifest and icons still load signed out.
- **Tests:**
  - Fake Access in tests: sign JWTs with a test key, serve fake certs.
  - Move `gate-live.ts` to `cloudflared access token`.
- **FEATURES rows:**
  - Retire `auth-gate`, `auth-cookie`, `auth-form`, `live-login`, `live-auth`.
  - Add `access-gate`, `access-jwt`, `access-bypass-paths`, `live-access`.
- **Done when:**
  - The UI is unreachable without a valid token.
  - A forged email header is refused.
  - Runners and uploads still work through the bypass paths.

### P. runner-pipe
- **Runner side:**
  - `http_request` handling, refusing any port not in its allowlist (`KY_RUNNER_PORTS`, later in `runner.json`).
  - Streamed responses; `http_cancel` aborts.
- **Worker side:**
  - A `Fetcher` backed by the runner socket, with backpressure and per-request timeouts.
  - A machine going offline fails its open requests at once.
- **Provider:** `runner-local` (C5), with an OpenAI-compatible or Anthropic-compatible API on `machine:port`.
- **VibeProxy:** becomes a `runner-local` record (Anthropic API, port 8317).
- **Overlay:** the VPC tunnel stays in the overlay as an alternative.
- **Done when:**
  - `main` on "Claude via VibeProxy on <machine>" streams a tool-using turn over the pipe.
  - Turning the machine off fails over to `fallback`, the same as today.

### K. vault-keys
- **Wiring:** `api-key` providers resolve through `vault.auth(id)` from `apiKey.resolve`; env secrets are no longer
  read.
- **Vault:** fill in `auth`.
- **UI:** the Providers panel becomes interactive in the existing style:
  - add a key (vendor, key, test call)
  - remove
  - status
  - last error
- **Done when:** pasting an Anthropic or OpenAI key makes those models selectable, and removing it falls back cleanly.

### S. subscriptions
These are the machine flows for ChatGPT and Claude.
- **Claude:**
  - The Settings › Subscriptions panel gets "Claude": paste the output of `claude setup-token`, check it with
    `claude auth status`-style validation on a machine (or store it as is), and save it under
    `vault.put("claude")`.
  - This token is only ever handed to the real `claude` CLI, as `CLAUDE_CODE_OAUTH_TOKEN`.
- **ChatGPT:**
  - Port Scotty's device-code flow into `vault.chatgptLogin`/`chatgptPoll`.
  - The UI shows the code and link, and the Vault polls with an alarm.
  - `sessionCreds("codex")` refreshes with CAS.
- **Handoff to tasks:**
  - Per-task `run.creds` is sent when the machine isn't signed in itself, or when the user picks "use ky's login" on
    that machine.
  - A `creds` frame pushes a refreshed Codex token before expiry while a task is open.
- **Runner:**
  - Writes `auth.json` into the per-task `CODEX_HOME`, or sets `CLAUDE_CODE_OAUTH_TOKEN` for that child only.
  - Deletes it when the task ends.
- **Done when:**
  - On a machine with neither CLI signed in, ky runs a Claude Code task and a Codex task using the Vault's
    credentials.
  - A Codex task outlives one token expiry. A fake clock in the harness proves it.

### C. cli-runner
- **Move the runner into the CLI:** `ky runner run`. `runner/` is deleted, and `ky-attach` / `ky-diff` become
  `ky attach` / `ky diff`.
- **`ky runner add [url code]`:**
  - Pairs (C2).
  - Stores the token in Keychain on macOS, or a 0600 file on Linux.
  - Writes `~/.config/ky/runner.json` (name, repos folder, permission mode, allowed ports).
  - Detects claude/codex logins, Chrome, repos, and local model ports (8317, 11434), and asks before sharing each.
  - Installs a launchd agent or a `systemd --user` unit (with linger), then waits until ky shows the machine online.
- **Other commands:** `ky runner ls`, `rm`, `status`, `logs`.
- **Upgrades:** `ky upgrade` restarts the service.
- **Done when:** on a second Mac or a Linux box, `ky runner add` goes from nothing to running a task.

### F. first-run
- **First-run screen** (empty providers, in the current Welcome style):
  - "You're on Workers AI."
  - Cards: add a key, connect ChatGPT for machines, add Claude for machines, add a machine.
- **SOUL interview:** a short chat that writes SOUL.md through the existing soul tools.
- **Seeds:** starter skills, one example specialist, and starter automations (a daily digest, and a weekly
  memory/dream review), all off by default.
- **Welcome pills** are gated on what's set up (machines, Executor, subscriptions).
- **Executor:** an optional connect (URL and token) stored in the Vault. `executor.ts` reads from it.
- **Done when:** a fresh deploy walks a new user from empty to a configured ky without touching a terminal past
  `ky init`.

### CM. cloud-machine
- **The container:**
  - `CloudMachine`, a container-enabled DO (migration v3).
  - Image: Debian slim with the `ky` runner binary, `claude`, `codex`, git, gh, node, pnpm and bun. Built by CI for
    linux/amd64, pushed by digest, and copied into the account registry by the deployer (Scotty's `deploy/image.ts`).
  - The deployer's container hook is filled in.
- **Pairing:** it pairs itself. `CloudMachine` mints its own machine token from the Vault, passes it at start, and
  sets `kind: "cloud"`.
- **Lifetime:**
  - `MachineHub#enqueue` (`machines.ts:256`) calls `CloudMachine.wake()`.
  - While any task is open, an alarm pings the container inbound (Scotty's deadlines). Its own outbound socket
    doesn't keep it awake.
  - It sleeps when idle.
- **Resume:**
  - Save to R2 on sleep: `~/.claude/projects`, each `CODEX_HOME`, and the work trees.
  - Restore on wake.
  - `follow-up`, `steer-folded`, `reconnect-outage` and `machine-move` must pass on cloud.
- **Credentials:** always `run.creds` from the Vault (S), plus `creds` refresh.
- **GitHub:**
  - git goes through the `github.internal` smart-HTTP proxy, with pushes limited to `ky/*`.
  - `gh` uses `vault.githubToken()`: a fine-grained token limited to the chosen repos (contents and pull requests),
    handed to the task's env.
  - Settings › Subscriptions gets "GitHub": paste the token and pick repos.
- **Free tier:** without Workers Paid, the deployer skips it and `doctor` says why.
- **Done when, with every personal computer off:**
  - a script task, a Claude Code task and a Codex task run on `cloud`;
  - one of those tasks sleeps, wakes and resumes;
  - a push to `ky/*` works, and a push to `main` is refused.

### RT. routing-self-edit
- **Routing:**
  - The `machine` tool description becomes agent-aware and lists each machine's facts.
  - Default to `cloud` for scripts, builds and repo work.
  - Use a personal computer for its Chrome, local files, local models, or when the user names it.
- **Prompt:**
  - Rewrite `prompt.ts`'s self-edit and ship-it so they run on `cloud`: clone `KY_REPO`, branch `ky/*`, test,
    `gh pr create`.
  - Deploy happens by GitHub Action on merge (`.github/workflows/deploy.yml`, a scoped Cloudflare token in repo
    secrets).
  - Rollback is `gh workflow run` on a previous SHA. No Cloudflare token anywhere in ky.
- **UI:** Machines shows `cloud` first, with its state (asleep, waking, running).
- **FEATURES rows:** `machine-facts` and `task-screenshot` become "machines with Chrome".
- **Done when:** ky edits itself, opens a PR from `cloud`, and the merge deploys, with the Mac off.

### REL. release
- **Distribution:**
  - A release workflow for darwin/linux × arm64/x64, a brew tap, `install.sh`, and an image workflow.
  - A `release.json` pins the Worker bundle and image digest.
- **Docs:**
  - README: quickstart (`brew install`, `ky init`), then add-ons (machines, subscriptions, VibeProxy, Executor).
  - The final FEATURES pass; live rows re-pointed.
  - A "Deploy to Cloudflare" button that gives Workers AI only and points to `ky` for the rest.
- **Done when:** a stranger on a clean Mac and a clean Cloudflare account follows the README to a working ky with
  a cloud machine.

## Deferred

- ChatGPT as ky's chat model (SIWC on `api.openai.com`, or the runner pipe). This comes after the machine flow.
- A Sandbox shell for the workspace. Shell work goes to `cloud` instead.

## Appendix: Workers AI provider (probed, working)

```js
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createAiBindingFetch, CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL as S } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
const ROOT = "https://workers-binding.ai/ai-gateway/gateways/default";
export function workersAI(ai) {
  const fetch = createAiBindingFetch(ai);
  const headers = { "cf-aig-authorization": `Bearer ${S}`, Authorization: null, "x-api-key": null };
  const wrap = (api) => ({
    stream: (m, c, o) => api.stream(m, c, { ...o, fetch, headers: { ...o?.headers, ...headers } }),
    streamSimple: (m, c, o) => api.streamSimple(m, c, { ...o, fetch, headers: { ...o?.headers, ...headers } }),
  });
  const models = Object.values(CLOUDFLARE_AI_GATEWAY_MODELS).filter((m) => m.api !== "openai-responses")
    .map((m) => ({ ...m, provider: "workers-ai", baseUrl: m.baseUrl.replace(/^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/[^/]+/, ROOT) }));
  return createProvider({ id: "workers-ai", name: "Workers AI", models,
    auth: { apiKey: { name: "binding", resolve: async () => ({ auth: { apiKey: S }, source: "AI binding" }) } },
    api: { "openai-completions": wrap(openAICompletionsApi()), "anthropic-messages": wrap(anthropicMessagesApi()) } });
}
```
