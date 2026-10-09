---
name: ky
description: Set up, check, upgrade and remove ky, a personal durable agent, on the user's own Cloudflare account with the `ky` CLI.
---

# ky

`ky` deploys ky to the user's Cloudflare account: a Worker with its Durable Objects, an R2 bucket for files,
Workers AI for models, and two Cloudflare Access apps, one that lets only the owner in and one that lets runners,
task uploads, the manifest and icons through. It keeps no Cloudflare token: each run uses `CLOUDFLARE_API_TOKEN`,
or else `wrangler login`'s.

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

`ky init` prints a KY_TOKEN once, the owner's sign-in until Access replaces it. Hand it to the user; don't store it.

## Keep it running

- `ky doctor` checks each piece and ends with `Next:`, the command or dashboard step that fixes the first one
  missing; do it (fill in any `<placeholder>`), then `ky doctor` again. `--json` prints `{ checks, next }`. It exits
  1 while anything is missing.
- `ky upgrade` deploys this `ky`'s release when the Worker runs another one. `ky deploy` deploys it regardless. A
  `ky` older than the Worker can't deploy over it: get a newer one.
- The settings are in `~/.config/ky/wrangler.local.jsonc`, the same overlay format as a checkout's
  wrangler.local.jsonc. It holds only `account_id`, `name`, `vars` (merged over ky's) and `vpc_services` (added);
  the bindings are the release's. Edit it, then `ky deploy`.

## Remove it

```sh
ky teardown --confirm <worker name>
```

This deletes the Worker with every chat and file, then its Access apps and its bucket, then the settings file. A
bucket another Worker binds, and an Access app ky didn't make, are left alone. Without the workers.dev subdomain ky
can't find its Access apps: it says where to remove them and keeps the settings file. It can't be undone: run it
only when the user asked for it by name.
