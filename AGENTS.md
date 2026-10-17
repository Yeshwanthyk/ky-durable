# Agents working in this repo

## Deploying

Never deploy from a checkout. A live ky's Worker must only ever be written by ky's own deploy, which
computes the whole config (the Access vars, the storage bucket, mail, the cloud machine) from the
owner's settings. A wrangler upload from the repo writes the base `wrangler.jsonc` plus whatever local
overlay is lying around, replaces the live version, and drops what it lacks: one did, and the owner's ky
answered every request with "Access isn't set up" and pointed its files at the wrong bucket.

- **Don't run** `pnpm deploy`, `wrangler deploy`, `wrangler versions upload`, `wrangler versions deploy`,
  `wrangler rollback`, `wrangler secret put`, or any other wrangler command that writes to a Worker or
  bucket, from this repo or any session.
- **To ship**, merge to `main`: `.github/workflows/deploy.yml` runs `ky deploy` with the owner's settings.
- **To redeploy or roll back**, run that workflow: `gh workflow run deploy.yml --ref main` (add
  `-f sha=<commit of main>` to roll back). Only when the owner asks for it.
- `ky deploy`, `ky upgrade` and `ky init` are the owner's to run on their own computer; ask, don't run them.
- **To check a deploy**, use `ky doctor [name]` and read-only wrangler commands (`wrangler versions list`,
  `wrangler deployments list`). These change nothing.
- Local work runs on the local stack (`pnpm stack`) or the harness (`pnpm harness`), never a live ky.
