# ky

Your own durable agent, on your own Cloudflare account. It lives in one Durable Object, answers in any browser
(and as a PWA on your phone), and keeps working with every computer you own switched off. One install, one
`ky init`, and you're chatting on Workers AI with no API key.

What it can do from the first minute: a `SOUL.md` you shape, memory across every chat (with background summaries
and `chat_search`), skills it writes and reviews for itself, nightly dreaming, side chats, subagents, specialists,
automations, a cloud browser, a workspace with files and images, and extensions over Executor. Add a computer or
the cloud machine and it runs Claude Code and Codex tasks too.

## Quickstart

You need a Cloudflare account. The free plan runs everything but the cloud machine, which needs
[Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/).

```sh
brew install yeshwanthyk/ky/ky
ky init
```

`ky init` signs in to Cloudflare (`CLOUDFLARE_API_TOKEN`, the token `ky login` kept, or your `wrangler login`), asks which
account, what to call the Worker and your email, and deploys ky behind Cloudflare Access so only you get in. If
Zero Trust is off, it shows where to turn it on (the free plan is enough) and waits; if the account has no
workers.dev subdomain, it asks for one. Then it opens ky.

`wrangler login` can't manage Access, so for `ky deploy` and `ky upgrade` run `ky login` once: it opens the page
that makes a token with everything a deploy needs, checks the token you paste has it, and keeps it (in the Keychain
on macOS, else `~/.config/ky/cloudflare-token`). `ky logout` forgets it.

Without Homebrew, on macOS or Linux (arm64 or x64):

```sh
curl -fsSL https://github.com/Yeshwanthyk/ky-durable/releases/latest/download/install.sh | sh
```

It puts `ky` in `~/.local/bin` (`KY_INSTALL_DIR` picks another folder, `KY_VERSION` another release) after checking
it against the release's checksums.

**Another program called `ky`?** Other tools use the name too. `ky --version` for this one ends in
`(ky-durable-cli)`. install.sh never replaces a `ky` that isn't this one: it says what it found and stops, and
`KY_INSTALL_DIR=<folder>` installs beside it, or `KY_INSTALL_FORCE=1` replaces it, keeping it as `ky.replaced`.
When another `ky` comes first on your PATH (from either install), run this one by its full path, such as
`/opt/homebrew/bin/ky init`, or put its folder first.

Once it's up, ky's Welcome shows what's left to set up, and `ky doctor` checks each piece of the deploy and
prints the command that fixes the first one missing.

## Add-ons

Each of these is optional, and each starts from ky's Settings.

**More models.** Workers AI's models come with every deploy, at no key. In Settings › Providers, paste an API key
for Anthropic, OpenAI or OpenCode Go; ky makes a test call before it keeps the key, in its Vault. The
best connected provider becomes the main model, and Settings › Models picks one per purpose: main, worker
(subagents, specialists, automations), background (titles, summaries, dreams) and fallback.

**Your computers.** A machine runs Claude Code or Codex tasks on a real computer, with its files, repos and,
if you let it, its Chrome. In Settings › Machines, Add a machine shows a command with a code good for ten
minutes. Run it on the computer (after installing `ky` there too):

```sh
ky runner add https://ky.<you>.workers.dev <code>
```

It finds the computer's `claude` and `codex` logins, Chrome, the folders holding git repos, and local model
servers (VibeProxy on 8317, Ollama on 11434), and asks before sharing each. It keeps the machine's token in
`~/.config/ky/runner-token` (0600), runs as a launchd agent or a `systemd --user` unit, and waits until
ky shows the machine online. `ky runner status`, `logs` and `rm` look after it; `ky upgrade` restarts it.

**The cloud machine.** On Workers Paid, `ky init` and `ky deploy` also attach a container, `cloud`, that runs
tasks, builds and ky's own changes with every computer off. It sleeps when idle and resumes its sessions when it
wakes. To let it work on your repos, add a fine-grained GitHub token in Settings › Subscriptions › GitHub
(contents and pull requests) and pick the repos; it may push only to `ky/*` branches. On the free plan
`ky doctor` says tasks run on your computers instead.

**Changing itself.** ky can change its own code: a task (on `cloud`, which holds no GitHub token and asks ky's Worker instead, or a
computer where `gh` is signed in) clones your copy of this repo, pushes a `ky/*` branch and opens a pull request; "ship it" merges it, watches the
deploy, and rolls back to the commit before if it fails. ky never holds a Cloudflare token; the deploy runs in
GitHub Actions (`.github/workflows/deploy.yml`) on every merge to `main`, with two repo secrets you add in your
copy's Settings › Secrets and variables › Actions:

| Secret | What it holds |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A token for ky's account with the permissions `ky init` asks for (Account Settings: Read, Workers Scripts: Edit, Workers R2 Storage: Edit, Access: Apps and Policies: Edit, Access: Organizations, Identity Providers, and Groups: Read), plus Containers: Edit with the cloud machine |
| `KY_OVERLAY` | The contents of `~/.config/ky/wrangler.local.jsonc`, which `ky init` wrote |

Without them the workflow deploys nothing and says so. Then set the repo, `owner/name`, in Settings › Self-edits,
and give the GitHub token in Settings › Subscriptions Actions: Read and write as well, so ky can watch the
deploy and roll it back.

**Subscriptions.** Settings › Subscriptions runs machine tasks on your own subscriptions, for computers that
aren't signed in themselves and for the cloud machine: paste the token `claude setup-token` prints for Claude, and
sign in with a device code for ChatGPT. The Claude token only ever reaches the real `claude` CLI; ky never calls
Anthropic with it.

**VibeProxy.** Claude in ky's own chat comes only from VibeProxy on
a computer of yours: run it on port 8317, and share that port when `ky runner add` asks. It shows in Settings as
"Claude via VibeProxy on <machine>" while that computer is online.

**Executor.** Connect Executor in Settings › Executor with its URL and a token, and ky gets
your connected apps as tools.

## Keep it up to date

```sh
brew upgrade ky        # or run install.sh again
ky upgrade             # deploys the new release, then restarts this computer's runner
ky upgrade work        # the same for a second ky, set up with `ky init --as work`
```

| Command | What it does |
| --- | --- |
| `ky login`, `ky logout` | Keep a Cloudflare token that can deploy ky, or forget it |
| `ky init [--as <name>]` | Set up and deploy ky (or a second ky, by name); run again, it fills in what's missing |
| `ky deploy`, `ky upgrade [name]` | Deploy this `ky`'s release with your settings |
| `ky doctor [name] [--json]` | Check each piece of the deploy, and print what fixes the first one missing |
| `ky backup [--out <file>]` | Download a copy of ky, its chats, memory, skills and files, to `~/ky-backups` |
| `ky restore <file> [--force]` | Put a backup into a fresh ky; it lists the keys and machines to add again |
| `ky teardown --confirm <worker>` | Delete the Worker with its chats and files, its bucket and Access apps |
| `ky runner add\|run\|ls\|status\|logs\|rm` | This computer as a machine |
| `ky skill` | The guide for an agent that runs `ky` for you |
| `ky --version` | This `ky`'s release |

Your settings are in `~/.config/ky/wrangler.local.jsonc` (`$XDG_CONFIG_HOME/ky/` when set), a second ky's in
`~/.config/ky/<name>/`. Each release pins
what it deploys in its `release.json`: the Worker bundle's digest and the cloud machine's image; `ky` refuses a
release whose files don't match it.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Yeshwanthyk/ky-durable)

The button deploys ky from this repo with Workers AI only: no machines, no cloud machine, no Access apps. Until
it's signed in, it answers that Access isn't set up. To finish it:

1. In the dashboard, open the new Worker › Settings › Domains & Routes, and turn on Cloudflare Access for its
   workers.dev address. Its Manage link shows the application's audience (AUD) tag and your team domain
   (`<team>.cloudflareaccess.com`).
2. In Settings › Variables and Secrets, add three **secrets** (secrets survive the next build's deploy; plain
   variables don't): `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `ACCESS_EMAILS` (your email).

For everything else (machines, the cloud machine, subscriptions, upgrades) use `ky`. `ky init` never adopts a
Worker it didn't deploy, so either give it another name (`ky init --name <name>`) or delete the button's Worker
first, with its chats.

## How ky is built

[docs/architecture.md](docs/architecture.md) is the reference: where things run, sign-in, models, machines and
the runner protocol. [FEATURES.md](FEATURES.md) lists every feature with the check that keeps it, and
[docs/release.md](docs/release.md) how a release is published.

## Develop

```sh
cp .dev.vars.example .dev.vars   # gitignored; set KY_DEV=1, KY_DEV_EMAIL and ACCESS_EMAILS
pnpm start   # vite dev with the Worker and DO, signed in as KY_DEV_EMAIL
```

`BROWSER` and `AI` (and `VIBEPROXY`, with the overlay) are remote bindings, so `pnpm start` needs
`wrangler login`. Without `wrangler.local.jsonc`, VibeProxy and Executor show as "Not set up". Without
VibeProxy or a key added in Settings, ky runs on Workers AI.

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
