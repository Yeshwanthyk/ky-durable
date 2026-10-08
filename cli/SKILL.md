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
can't manage Access; when `ky` says so, the user creates the token its message links to and runs with
`CLOUDFLARE_API_TOKEN` set.

`ky init` prints a KY_TOKEN once, the owner's sign-in until Access replaces it. Hand it to the user; don't store it.

## Keep it running

- `ky doctor` checks each piece and ends with `Next: <command>`; run that command, then `ky doctor` again. `--json`
  prints `{ checks, next }`. It exits 1 while anything is missing.
- `ky upgrade` deploys this `ky`'s release when the Worker runs another one. `ky deploy` deploys it regardless.
- The settings are in `~/.config/ky/wrangler.local.jsonc`, the same overlay format as a checkout's
  wrangler.local.jsonc: `vars` merge over ky's, `vpc_services` are added. Edit it, then `ky deploy`.

## Remove it

```sh
ky teardown --confirm <worker name>
```

This deletes the Worker with every chat and file, its bucket and its Access apps, then the settings file. It
can't be undone: run it only when the user asked for it by name.
