# Agents working in this repo

## Deploying

Never write a live ky with wrangler. A live ky's Worker must only ever be written by ky's own deploy, which
computes the whole config (the Access vars, the storage bucket, mail, the cloud machine) from the
owner's settings. A wrangler upload from the repo writes the base `wrangler.jsonc` plus whatever local
overlay is lying around, replaces the live version, and drops what it lacks: one did, and the owner's ky
answered every request with "Access isn't set up" and pointed its files at the wrong bucket.

- **Don't run** `pnpm deploy`, `wrangler deploy`, `wrangler versions upload`, `wrangler versions deploy`,
  `wrangler rollback`, `wrangler secret put`, or any other wrangler command that writes to a Worker or
  bucket, from this repo or any session.
- **To ship**, merge to `main`: `.github/workflows/deploy.yml` runs `ky deploy` with the owner's settings.
  It deploys only the ky its overlay names (squarey); every other ky (oblongy) is deployed by hand, below.
- **To redeploy or roll back**, run that workflow: `gh workflow run deploy.yml --ref main` (add
  `-f sha=<commit of main>` to roll back). Only when the owner asks for it.
- **To deploy a ky by hand** (`ky deploy <name>`), only when the owner asks, from a clean checkout of `main`
  after its merge, as the workflow does:
  1. Pin the newest release's cloud image: `GH_TOKEN=$(gh auth token) scripts/image/last.sh` prints `ref=`;
     write that ref as `container/image.digest`'s only uncommented line. The checkout's own pin can be older
     and would roll the cloud machine back.
  2. `pnpm compile darwin-arm64`. `pnpm ky` deploys whatever `dist/release` last built, so skipping this
     ships an old release.
  3. `pnpm ky deploy <name>`, then `git checkout container/image.digest`.
  4. `pnpm ky doctor <name>`: the Release line names `main`'s commit and nothing is marked ✗.
- **After a release with a data migration ships** (src/migrations.ts gained one), roll forward, never back: an older
  Worker can't read what the migration rewrote (it refuses the newer level, or parks tasks of kinds it doesn't know).
  Fix forward with a new release; the workflow's `-f sha=` rollback is only for releases with no new migration.
- `ky upgrade` and `ky init` are the owner's to run on their own computer; ask, don't run them.
- **To check a deploy**, use `ky doctor [name]` and read-only wrangler commands (`wrangler versions list`,
  `wrangler deployments list`). These change nothing.
- Local work runs on the local stack (`pnpm stack`) or the harness (`pnpm harness`), never a live ky.

## Git

- Commit messages and PR bodies carry no `Co-Authored-By`, "Generated with" or other agent attribution lines.
