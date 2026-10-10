---
name: ky
description: Set up, check, upgrade and remove ky, a personal durable agent, on the user's own Cloudflare account with the `ky` CLI.
---

# ky

`ky` deploys ky to the user's Cloudflare account: a Worker with its Durable Objects, an R2 bucket for files,
Workers AI for models, and two Cloudflare Access apps, one that lets only the owner in and one that lets runners,
task uploads, the manifest and icons through. It keeps no Cloudflare token: each run uses `CLOUDFLARE_API_TOKEN`,
or else `wrangler login`'s.

## Install

```sh
brew install yeshwanthyk/ky/ky
# or: curl -fsSL https://github.com/Yeshwanthyk/ky-durable/releases/latest/download/install.sh | sh
```

Other programs are named `ky` too. This one's `ky --version` prints `ky <version> (ky-durable-cli)`; if it prints
anything else, another `ky` comes first on the PATH, so run this one by its full path (`$(brew --prefix)/bin/ky`,
or `~/.local/bin/ky` from install.sh). install.sh never replaces another `ky`: it stops and says what it found;
`KY_INSTALL_DIR=<folder>` installs beside it, and only the user should choose `KY_INSTALL_FORCE=1`, which replaces it.

## Set up

```sh
ky init --account <id or name> --name ky --email <owner email>
```

Without a terminal every answer is a flag; a missing one fails with the flag's name. Add `--subdomain <name>` when
the account has no workers.dev subdomain yet. Before Access can be set up, the account needs Zero Trust on (the
free plan is enough): `ky init` fails with the dashboard link until it is. `wrangler login` deploys Workers but
can't manage Access; when `ky` says so, the user creates the token its message links to (Account Settings: Read,
Workers Scripts: Edit, Workers R2 Storage: Edit, Access: Apps and Policies: Edit, and Access: Organizations,
Identity Providers, and Groups: Read) and runs with `CLOUDFLARE_API_TOKEN` set.

Run again, `ky init` keeps the settings it saved and asks only for what's missing. A Worker or bucket of that name,
or an Access app already guarding its address, that ky didn't make is never changed: pick another `--name`.

## Keep it running

- `ky doctor` checks each piece and ends with `Next:`, the command or dashboard step that fixes the first one
  missing; do it (fill in any `<placeholder>`), then `ky doctor` again. `--json` prints `{ checks, next }`. It exits
  1 while anything is missing.
- `ky upgrade` deploys this `ky`'s release when the Worker runs another one. `ky deploy` deploys it regardless. A
  `ky` older than the Worker can't deploy over it: get a newer one. It also restarts this computer's runner
  service, if there is one, so the runner runs the new release.
- The settings are in `~/.config/ky/wrangler.local.jsonc`, the same overlay format as a checkout's
  wrangler.local.jsonc. It holds only `account_id`, `name`, `vars` (merged over ky's) and `vpc_services` (added);
  the bindings are the release's. Edit it, then `ky deploy`.

## Add a machine

A machine runs ky's tasks as Claude Code or Codex sessions. In ky, Settings, Machines, Add a machine shows a code
good for ten minutes; on that computer:

```sh
ky runner add <ky url> <code>      # --yes shares what it finds (never Chrome); --no-service starts nothing
```

It pairs, keeps the token in the Keychain (macOS) or a 0600 file (Linux), writes `~/.config/ky/runner.json`,
installs a launchd agent or `systemd --user` unit, and waits until ky shows the machine online. Then:
`ky runner ls`, `ky runner status [--json]` (exits 1 unless online), `ky runner logs [-f]`, and `ky runner rm`, which
removes it from this computer only: the user removes the machine in ky's Settings too. `ky runner run` is the runner
itself, in the foreground. Tasks run `ky attach <file>` and `ky diff` to share files and changes.

## Remove it

```sh
ky teardown --confirm <worker name>
```

This deletes the Worker with every chat and file, then its Access apps and its bucket, then the settings file. A
bucket another Worker binds, and an Access app ky didn't make, are left alone. Without the workers.dev subdomain ky
can't find its Access apps: it says where to remove them and keeps the settings file. It can't be undone: run it
only when the user asked for it by name.
