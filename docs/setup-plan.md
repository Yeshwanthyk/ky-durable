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
| `creds` | `seq, task, codex` | Mid-task Codex token refresh. Sent (added by S) at a runner `hello` when the Vault's login is newer than the one the task was last handed; the runner ignores it for a task that runs on the machine's own login. |
| `http_request` | `id, port, method, path, headers, body?` | `body` is base64. Only to a port in the runner's `facts.ports`; any other is answered with `http_error`. |
| `http_cancel` | `id` | Sent when the reader aborts or cancels, after 120s without a frame, or when the reader falls 8 MiB behind (C1 has no flow-control frame toward the runner) (changed in P). |
| `goodbye` | `reason, expected?` | Sent before close code 4426 on a protocol mismatch, or 4401 on a revoked token. |

**Runner → object**

| Frame | Fields | Notes |
|---|---|---|
| `hello` | `protocol: integer, version, active, facts` | The server reads `protocol` first, then validates the rest. `facts` = `{ os, chrome, repos, agents: { claude: { installed, signedIn }, codex: { installed, signedIn } }, ports: number[], kind: "computer"\|"cloud" }`. |
| `ack`, `session`, `step`, `result` | as in v2 | `result` gains `agent`. |
| `http_head` | `id, status, headers` | |
| `http_chunk` | `id, data` | `data` is base64, at most 48 KiB of body per chunk (changed in P). |
| `http_end` | `id` | |
| `http_error` | `id, message` | |

**Child process env:** `KY_URL`, `KY_TASK`, `KY_TASK_TOKEN`, plus the agent's own credential when `creds` was sent
(`CLAUDE_CODE_OAUTH_TOKEN`, or an `auth.json` in a per-task `CODEX_HOME`). The machine token is never in a child's env.

### C2. HTTP routes

| Route | Auth | What it does |
|---|---|---|
| `POST /api/runners/codes` | Access | Returns `{ code, expiresAt }`. 10 minutes, single use. |
| `POST /api/runners/pair` | none | Body `{ code, name, facts }`; returns `{ machine, token }`. Rate limited: 10 a minute per `CF-Connecting-IP`, the `PAIR_LIMIT` Workers rate-limit binding (429). A bad name or facts is a 400 and leaves the code unspent; a wrong, used or expired code is a 401. |
| `DELETE /api/runners/<machine>` | Access | Forgets the machine, closes the socket and revokes the token. 204, or 404 for no such machine. Any method but `POST` on `/api/runners/codes` is a 405. |
| `POST /api/files?task=<id>` | `Bearer <taskToken>` | Matched to the task. |
| `GET /files/<id>` | Access | Serves a shared file, whole or by range. (A changed it from `GET /api/files/<id>`: Access treats the bypass path `/api/files` as covering everything under it, so downloads there would skip the login.) |
| `GET /runner/<machine>` | `Bearer <machine token>` | The runner socket. The token is checked before the upgrade: a bad one is a 401 even without `Upgrade`, so a runner can probe it with a plain GET; a good one without `Upgrade` is a 426. |

**Pairings (added by T):** each pairing gets a random id, which the agent keeps in the machine's `ky_machines` row.
The row is the machine's paired state: pairing writes it, remove deletes it, and a hello only updates it. The
machine token's subject is `<machine>:<pairing>`. The Worker passes the pairing to the agent in `X-Ky-Pairing`, and
the agent takes the socket, and later its hello, only if that pairing is still the machine's. Otherwise it sends
`goodbye` and closes with 4401. So a remove or a new pairing that lands between the Worker's token check and the
socket's hello brings nothing back. `/pair` mints the new token before the agent takes the pairing, then revokes
the token of the pairing it replaced. So of two pairings of one name racing, the later write revokes the earlier
one's token, which already exists.

**Access bypass paths:** `/runner/*`, `/api/runners/pair`, `/api/files`, `/manifest.webmanifest`, `/icons/*`.
`BYPASS` in `src/access.ts` holds this list (A moved it from `cli/deployer.ts`), and both the Worker's check and the
deployer's bypass app read it. As in Access, `/a` covers `/a` and every path under it, and `/a/*` every path under it.

### C3. Access (`src/access.ts`)

- **Env:** `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`), `ACCESS_AUD`, `ACCESS_EMAILS` (comma separated).
- **Every non-bypass request and socket upgrade:**
  - Verify `Cf-Access-Jwt-Assertion`: an RS256 signature against `https://<team>/cdn-cgi/access/certs` (keys
    cached an hour; a key id they lack fetches them again at most once a minute), `aud` contains `ACCESS_AUD`,
    `iss` is `https://<team>`, and `exp`/`nbf`. A failed certs fetch is a 503.
  - The email must be in `ACCESS_EMAILS`.
  - A bare `cf-access-authenticated-user-email` header is never trusted.
- **Dev:** when `KY_DEV=1`, `KY_DEV_EMAIL` stands in; it must still be in `ACCESS_EMAILS`. Set only in local and test configs.
- Missing `ACCESS_*` vars close ky: every non-bypass request is a 500.
- `KY_TOKEN`, `auth.ts`, the login form and the cookie are deleted, and `ky deploy` no longer sets or checks a `KY_TOKEN`.

### C4. Vault (`src/vault.ts`, DO class `Vault`, `getByName("owner")`, SQLite, migration v2)

```ts
// secrets: kind is any string, e.g. "provider", "claude", "chatgpt", "github", "executor"; a new kind needs no Vault change (changed in K: it was a closed list)
put(kind, id, value: Json, meta?: SecretMeta): void          // meta is flat (strings, numbers, booleans, string[]) so it crosses RPC typed
remove(kind, id): void
status(): { kind, id, meta, updatedAt, error? }[]          // never secrets; error is the last failed refresh's
auth(providerId): { apiKey: string; headers?: Record<string,string> } | null   // the ("provider", providerId) secret, which models.ts puts once a test call takes it
sessionCreds(agent: "claude" | "codex"): Promise<RunCreds[agent] | null>   // async (S); refreshes codex with the internal refresh (below)
chatgptLogin(): Promise<{ userCode, verificationUrl, loginId }>; chatgptPoll(loginId): "pending" | "done" | { error }
githubToken(): { token, repos } | null
executor(agent): { url, token } | null                       // added by F: the ("executor", agent) secret, with meta { url }
// tokens: kind = "pair" | "machine" | "task"
mint(kind, subject, ttlMs?): string                          // returns raw once; stores sha-256; one live token per (kind, subject), so minting again replaces it
check(kind, token): subject | null                           // a lookup by hash
consume(kind, token): subject | null                         // check, and delete it: single use, one winner when callers race
revoke(kind, subject): void
issue("task", subject): string                              // added by T: the subject's live token again, or a new one if none; never replaces
revokeAll("task", subjects: string[]): void                  // added by T: revoke each subject's token
```

- **`issue` (added by T):** a task's token has to reach the runner again in every resend and follow-up while the task lives, without the agent keeping it. So the Vault stores a random nonce with the token's hash, and derives the token as HMAC-SHA256 of the nonce under a key it keeps (`ky_vault_keys`). The key and the nonce are in the same SQLite, so the Vault can derive an issued token again whenever it likes: unlike a minted token, an issued one is as safe as the Vault's storage, not only as its hash. `issue` derives it again while the row is live; once it is revoked or expired it makes a new one. Every await comes before its read and write of the row, so racing calls share one token, and a revoke that lands while it derives wins. Each issue sets the token to expire `ISSUED_TTL_MS` (24 hours, `src/runner-protocol.ts`) from now: a resend refreshes it, so it outlives any turn, and a revoke that was lost leaves a token that works for a day at most. `check` and `revoke` work on it as on a minted token.

- **Pair codes:** each one is minted with a fresh random subject (for example `crypto.randomUUID()`), so codes outstanding at once never replace each other, and is redeemed with `consume`.
- **`refresh(kind, id, fn)` is internal**, used inside the Vault only (by `sessionCreds`): its callback can't cross the typed RPC stub. It is a CAS on the secret's generation, which every `put` and every successful refresh bump. Callers of one generation share one `fn`. A `put` or `remove` that lands first wins, and the refresh answers with what is stored now, or null, whether `fn` succeeded or failed.
- **Subscriptions (added by S):** both are kept under the id `SUBSCRIPTION = "subscription"`: `("claude", SUBSCRIPTION)` holds `{ oauthToken }` with meta `{ expiresAt }`, and `("chatgpt", SUBSCRIPTION)` holds the ChatGPT login with its refresh token, which never leaves the Vault (`run.creds.codex.refreshToken` is always null). `sessionCreds("codex")` refreshes when under an hour (`CODEX_RENEW_BEFORE_MS`) is left; a refresh that fails hands out the stored token while it lasts. Sign-ins in progress are rows of `ky_vault_logins`, which the Vault's `alarm` polls; one sign-in at a time. Its OpenAI `fetch` is the field `openai`, which the test stack replaces with `test/fakes/openai.ts`.
- **Refresh errors:** when `fn` fails on an unchanged secret, its message is stored verbatim as the secret's `error`, which `status` and Settings show. So a refresh function must throw messages that hold no secret.

### C5. Providers and purposes (`src/models.ts` and `src/providers/*`)

- **Provider records** are stored in `ky_providers`:
  `{ id, kind: "workers-ai" | "api-key" | "runner-local", vendor, machine, port, api, label, enabled }`, where
  `vendor`, `machine`, `port` and `api` are `null` for a kind that has none (changed in M: they were optional).
  The credential for an `api-key` record lives in the Vault under `("provider", id)`.
  A `workers-ai` or `runner-local` record is added on the first boot its provider can run. An `api-key` record is
  added when the user saves its key in Settings after a test call succeeds, and removed with the key (changed in K:
  it was added on boot when its env secret was set). Each later boot refreshes `kind`, `vendor`, `machine`, `port` and `api` from the environment; `label` and `enabled` keep the user's values (changed in M review 2: it was insert-only).
- **Purposes:**

| Purpose | Default |
|---|---|
| `main` | Best connected; with none connected, the best enabled |
| `worker` (subagents, specialists, automations) | `main` |
| `background` (titles, memory summaries, dreams, skill reviews) | Workers AI's default model at its lowest thinking level; `main`'s while the Workers AI record is disabled |
| `fallback` | Best healthy model on another provider than `main`'s; else the best that isn't `main`'s model |

- `main` is the best connected provider's default, ranked runner-local, then api-key, then Workers AI.
- **VibeProxy** is one `runner-local` record, `vibeproxy`, on `api: "anthropic-messages"` (changed in P):
  - Its `machine` is the paired machine whose `facts.ports` holds its port (8317), an online one first, then the
    first by name. It is reached over the pipe and shown as "Claude via VibeProxy on <machine>".
  - **The pipe wins:** only when no machine shares the port does the overlay's tunnel carry it (`machine: null`,
    "Claude via VibeProxy"). With neither it keeps its last place. Each runner hello and close re-places it.
  - A runner-local provider is connected only while its machine is online and its probe answers. A machine going
    offline makes it down at once, so the next call runs on a stand-in.
  - Its key is `VIBEPROXY_KEY` when set, else a placeholder: VibeProxy on 127.0.0.1 checks none by default.
  - It counts as not set up while there is neither a tunnel nor a machine sharing the port.
  - `ModelsBoundary.vibeProxy` is `{ port, key?, tunnel?: { binding, origin } }`: it was the tunnel alone.
- **API** (changed in M):
  - `models.resolve(purpose, need?: { images? })` returns `{ choice, model }`: the user's choice for the purpose
    while it can run, else the default above. It is synchronous and doesn't check health.
  - Every provider offers only tool-capable models, so `need` has no `tools`; pi compacts by the model's own
    window, so it has no `context`.
  - Health is checked per call, as the call starts: VibeProxy's probe, and every provider's breaker on
    401/402/429/5xx. A call whose provider is down runs on a stand-in on another provider that is healthy now:
    the user's `fallback` choice while its provider is, else the best there. A `background` call's stand-in is the
    cheapest healthy provider's light model instead (Workers AI, then api-key, then runner-local; Haiku on VibeProxy),
    so titles and summaries never fall to Opus (changed in M review 2). There is no stand-in on the same
    provider, and a stand-in is never re-routed (changed in M review: it could bounce between two down providers).
    With no other provider healthy, the call runs on its own provider, fails fast, and pi's retry applies.
  - With no provider enabled no purpose resolves: `resolve` throws, and the Settings view (`SettingsView.purposes`,
    now partial) lists none, so Settings still opens and says so (changed in M review 2).
  - It's the only way any caller picks a model. `imageSupport(purpose)` asks it, and answers for the stand-in's
    model while the purpose's provider is down.
  - Workers AI's thinking levels are per model, from live probes of the compat endpoint (changed in M review:
    no level was sent before). Each level is sent as `reasoning_effort`:
    - GLM 5.3 Flash offers none. It thinks on its own (240–530 tokens on a title); any effort cuts that to a few
      tokens whatever its value, and "none" is ignored.
    - Kimi K2.6 offers off ("none", which stops it thinking) and high.
    - GPT OSS 120B offers low, medium and high; it refuses "none".
  - Thinking shares `max_tokens`. GLM's own thinking stays well inside a title's or summary's budget (2000 and 8000).

### C6. Owner overlay

- `wrangler.jsonc` is generic.
- `wrangler.local.jsonc` (gitignored) holds the owner's vars, the VPC binding and routes.
- `pnpm run deploy` uses it when present; the CLI deployer writes the equivalent for CLI users.
- The CLI's overlay is `~/.config/ky/wrangler.local.jsonc` (`$XDG_CONFIG_HOME/ky/` when set): the same format,
  merged over the release's generic `wrangler.jsonc` by the same `applyOverlay`. `ky deploy` reads only that file,
  never a checkout's `wrangler.local.jsonc`.
  - It holds only `account_id`, `name`, `vars` (with `ACCESS_EMAILS`) and `vpc_services`, the keys the overlay
    merges or that are the owner's. Any other key would replace the release's own (overlay arrays replace), so the
    CLI refuses an overlay that sets one, `r2_buckets` and `routes` among them; a custom domain deploys with
    `pnpm run deploy`. The deployer refuses `containers` until CM.
  - Every binding is the release's, so a release that changes them reaches every user on `ky upgrade`. Each bucket
    is named from the Worker and its binding, `<name>-<binding>` (`ky-files` for `FILES`); a name R2 won't take
    is refused before anything is written.
  - `ky init` writes it, and run again fills in only what it lacks: `ky doctor` names that `ky init` and its flags.

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
  - Create the C6 overlay with today's values. `pnpm run deploy` and `pnpm start` use it when present. Add it to
    `.gitignore`.
  - Add `.dev.vars.example`.
- **Soft-fail:**
  - Each optional binding and var (`VIBEPROXY`, `VIBEPROXY_ORIGIN`, `EXECUTOR_*`, `OPENCODE_API_KEY`) shows up as
    "not set up".
  - The DO constructor never throws.
  - `boundaryFor` builds VibeProxy and Executor only when they're configured. OpenCode Go stays in the catalog
    without its key, marked not set up, because the slot defaults end on it; M replaces that default.
    (K removed `OPENCODE_API_KEY`: OpenCode Go's key is added in Settings like the other vendors'.)
- **Derived values:**
  - `KY_URL` from the request origin: the origin of the page that sets the repo, saved with it and shown in
    Settings › Self-edits.
  - `KY_REPO` becomes a DO setting, set in Settings › Self-edits (`src/setup.ts`).
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
  - Token methods `mint`, `check`, `consume` and `revoke`, with sha-256 hashes looked up by hash, and expiry.
  - A generic internal `refresh(kind, id, fn)` CAS helper on a generation, ported from Scotty `CredsObject:183-225`.
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
  - Code from `mint("pair", crypto.randomUUID(), ttl)`, redeemed with `consume("pair", code)` and exchanged for
    `mint("machine", name)`.
  - Revoke closes the live socket with `goodbye` and 4401.
- **Task tokens:** `run` carries `taskToken = issue("task", taskId)` (C4), issued as each run is sent so the agent
  never stores it, and revoked when the task ends.
  - Revokes are best effort, so the agent also sweeps at start: `revokeAll("task", …)` with its machine tasks that
    ended within `ISSUED_TTL_MS` and are over by the rule the end revoke uses: every turn reported over, and no run
    of the task in the inbox. Status alone is not enough: a stop with a follow-up queued sets the task stopped while
    the follow-up turn runs with the same token. A token of a task that ended earlier has expired. The sweep names
    only the agent's own tasks, because the one Vault serves every agent object.
  - A delivery whose `issue` fails is tried again 1, 2, 4, 8 and 16 seconds later, while the inbox keeps the runs.
    After that, the runner's next hello (it says one on every connect) or the next command for the machine delivers.
    A retry is a timer in memory, so an eviction loses it, and the runs wait the same way.
- **Pairings:** see C2. A machine row with no pairing, from before T, is listed but refused until the machine pairs
  again. A machine token from before T has the subject `<machine>`, with no pairing. No route takes it, and the
  Vault deletes it when it starts.
- **Uploads:** `/api/files` checks the token. `ky-attach` and `ky-diff` use `KY_TASK_TOKEN`.
- **Runner:**
  - Reads its machine token from `KY_RUNNER_TOKEN_FILE` (default `~/.config/ky/runner-token`, mode 0600).
  - Stops reading `KY_TOKEN`.
  - Its children get only C1's env.
- **UI:** Machines panel gets "Add a machine", which shows the code and the command (`ky runner add <url> <code>`,
  from C). It also gets "Remove". Use the current panel's
  look.
- **Fallow:** the `unused-class-member:src/vault.ts:Vault:*` entries stay in `fallow/dead-code.json`, and T adds
  `issue` and `revokeAll`. fallow does not follow calls through a Durable Object stub into a class declared outside the Worker's
  entry (it counts `PiAgent`'s members only because `src/server.ts` declares it), so `mint`, `check`, `consume`,
  `revoke`, `issue` and `revokeAll` look unused even with T's callers in `src/runners.ts`.
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
- **Built:** each Codex task's home is `KY_STATE_DIR/codex/<task>` (`codexHome` in `runner/ky-runner.ts`), and its
  `auth.json` is a link to the machine's `CODEX_HOME/auth.json`. S hands a task `run.creds.codex` by writing
  `auth.json` there as a file in place of the link, mode 0600, and rewriting it on a `creds` frame; the next
  `codex exec` of that task reads it. A run is refused only when the last-known `facts.agents` says its CLI is not
  installed (looked for again first); a signed-out one still starts, so a run with `creds` already gets through on
  a machine that is not signed in itself. The runner deletes a home 14 days after its last turn, so S's `auth.json`
  in it goes too.

### D. cli-deploy
- **Package:** `cli/`, a Bun-compiled `ky`.
  - Port Scotty's `cli/binary.ts`, `deploy/compile.ts`, `deploy/release.ts`.
  - Embed the release pack: the Worker bundle and assets.
- **Deployer** (port of `deploy/deployer.ts` over `@distilled.cloud/cloudflare`):
  - Script with the C6 bindings; the migrations the Worker hasn't run (all of them on the first deploy, then only
    new ones).
  - Assets, R2 bucket, `AI` binding, secrets.
  - Access app plus a bypass app for the C2 paths. Sets `ACCESS_*` (C3). Both carry the `ky` tag, as the Worker
    does; an untagged app already guarding the address is refused, never adopted or removed.
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
- **Overlay:** the VPC tunnel stays in the overlay as an alternative. The pipe wins while a machine shares the
  port (C5).
- **Built (P):** `runner/forward.ts` (runner side), `src/pipe.ts` (`RunnerPipe`, the Worker's fetcher),
  `src/providers/runner-local.ts` (the provider, with Anthropic's and OpenAI's chat APIs), and
  `src/providers/vibeproxy.ts` on top of it. No record uses the OpenAI API yet: C's `runner.json` declares a
  machine's other servers and their models.
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
- **Built (K):**
  - Vendors are Anthropic, OpenAI and OpenCode Go (`VENDORS` in `src/providers/api-key.ts`). A Claude subscription
    token (`sk-ant-oat…`) is refused: pi would send it as Claude Code does.
  - Client messages `add-key { vendor, key }` (answers `{ refused? }`, never the key) and `remove-key { provider }`.
  - `SettingsView` gains `vendors` (those with no key yet); `ProviderInfo` gains `kind` and `failure` (why its
    breaker last opened, until a response succeeds).
  - The registry is built with an empty auth context, so pi never reads a key from the env or files.

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
- **Contract changes (added by S):**
  - Browser socket: `set-claude { token }` answers `{ refused? }`; `remove-subscription { kind }`;
    `chatgpt-login` answers `{ userCode, verificationUrl, loginId }` or `{ refused }`; `chatgpt-poll { login }`
    answers `"pending" | "done" | { error }`. The server frame `subscriptions` lists
    `{ kind: "claude" | "chatgpt", connected, expiresAt: number | null, error: string | null }`, never a token.
  - `MachineInfo.login: "own" | "ky"` (`ky_machines.login`, default `own`), set with `set-machine { login }`.
  - `MachineHub` takes a sixth argument, `creds: (agent) => Promise<RunCreds>` (`Subscriptions.creds`). The inbox
    keeps runs and `creds` commands without their secrets; both are filled as they are sent. `ky_machine_logins`
    keeps, per task, the expiry of the Codex login it was last sent, so a newer one is queued once.
  - The Claude token is checked by its shape only (`sk-ant-oat…`), never by a call: nothing in ky calls Anthropic
    with it, so a revoked token shows up as the task's "Not logged in".

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
- **Built (C):**
  - `cli/runner/` holds the runner (`run.ts` the process, `tasks.ts` how it starts each agent, `facts.ts` what
    it reports, `share.ts` for `ky attach` / `ky diff`), and `ky runner add|run|ls|status|logs|rm`
    (`commands.ts`, `service.ts`, `settings.ts`, `token.ts`). Each task's PATH gets a `ky` in `~/.ky/bin` that runs
    this `ky`. Settings' "Add a machine" shows `ky runner add <origin> <code>`.
  - One runner per computer: `runner.json` is this computer's. `ls` shows it; ky has no route that lists
    machines for a machine token. `rm` is local, and says to Remove the machine in ky's Settings, which revokes
    the token.
  - "Online" is the runner's own status file (`~/.ky/runner-status.json`): `add` waits until the runner it
    started says ky took its socket, and stays so for 2s. No contract changes.
  - Services: launchd `dev.ky.runner` (not the old `com.ky.runner`) with KeepAlive unless it exits 0, and
    systemd `ky-runner.service` with `Restart=on-failure` and linger. A runner ky turns away exits 0 under the
    service, so neither restarts it in a loop. `ky upgrade` kickstarts or restarts whichever is loaded.
  - The Keychain item (service `ky runner`, account `<name>@<host>`) is written through `security -i`'s stdin.
    `KY_RUNNER_TOKEN_FILE` keeps it in a file instead, e.g. for a Mac with no unlocked login Keychain.
  - `--yes` shares what it found but never Chrome; `--no-service` starts nothing.

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
- **Built (F):**
  - The main chat's Welcome shows first-run cards while anything is left to set up: tell ky who you are (SOUL
    interview), add a key, connect ChatGPT for machines, add Claude for machines, add a machine, connect Executor.
    Each card opens and scrolls to the existing Settings section (`settings-providers`, `settings-subscriptions`,
    `settings-machines`, `settings-executor`); a done card is checked. The title reads "You're on Workers AI." while
    Workers AI is the only provider.
  - The SOUL interview is a prompt sent into the main chat: ky asks three or four questions one at a time, then
    writes SOUL.md with `soul_edit`. Its card is done once SOUL.md has a second version.
  - Seeds run once per ky (`Setup` key `seeded`), on its first start: skills `research-brief` and `inbox-triage`
    (archived), specialist `editor`, automations "Daily digest" (`0 8 * * *`) and "Weekly review" (`0 9 * * 1`)
    (paused). Automation runs get no memory, so the weekly review reviews skills, not memory or dreams.
  - Welcome pills: "What's connected" only with Executor; "Use my computer" only with a machine; "Code on my
    machine" only with a machine and a Claude or ChatGPT subscription.
  - Fixes from live testing: K's refusal of a Claude subscription token as an Anthropic key now says it goes in
    Settings › Subscriptions and links there; Settings › Subscriptions is disabled until a machine is paired, with a
    link to Settings › Machines; S's `set-claude` strips all whitespace (a terminal's wrap) before matching, and its
    refusals say what is wrong without echoing the paste.
- **Contract changes (added by F):**
  - Vault: `executor(agent)` (C4). Executor's URL and token are no longer config: `EXECUTOR_URL` and
    `EXECUTOR_TOKEN` are gone, and "Not set up" lists VibeProxy only.
  - Browser socket: `set-executor { url, token }` tests the token with `tools/list` and answers `{ refused? }`;
    `remove-executor`. Server frames `executor { url | null }` (never the token) and `tools` (the tool list after
    Executor's tools are installed or removed at runtime).
  - Boundary: `executorFetch` (the test stack's MCP fake) and `seeds` (whether a new ky is seeded; the stack seeds
    only objects named `fresh-…`).

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
