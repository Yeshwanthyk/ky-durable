# Releasing ky

A release is the `ky` binary for macOS and Linux on arm64 and x64. Each one carries the release it deploys: the
Worker's modules, the web app, the generic `wrangler.jsonc` and the guide for agents (`cli/release.ts`). Its
`release.json` pins all of them by digest (`bundle`). The cloud machine's image holds the linux-x64 binary, so
the binary can't hold the image's digest: it names the `release.json` published beside it (`imageFrom`), which
pins the image (`image`). `ky deploy` reads that file and checks it's the same release.

| Piece | File | What it does |
| --- | --- | --- |
| Release workflow | `.github/workflows/release.yml` | On a tag `v<version>`: checks the tag is `package.json`'s version and runs `pnpm compile` for every platform with `KY_VERSION`. Then it keeps the image the newest release deploys if nothing it runs changed, or builds one around the release's own linux-x64 binary. Then it packs and publishes the GitHub release, and writes the brew formula into the tap |
| Image inputs | `container/image.inputs`, `scripts/image/` | What the image runs: the runner and what it imports, the Dockerfile, the lockfile. `scripts/image/current.ts` says whether an image built from one commit is current for another, and checks the list against Bun's module graph (`pnpm test:node` does too). `last.sh` finds the newest release's image and the commit it was built from (its label) |
| Image build | `.github/actions/cloud-image` | Builds `container/Dockerfile` for linux/amd64 around `dist/bin/ky-linux-x64`, pushes `ghcr.io/<owner>/ky-cloud`, checks it's public |
| Image preview | `.github/workflows/image.yml` | By hand only: an image of a branch's checkout build, and the lines that pin it in `container/image.digest` (what a checkout's `pnpm compile` deploys) |
| Packing | `scripts/release/package.sh` | `dist/out`: `ky-<platform>.tar.gz`, `release.json` (with `KY_IMAGE` as its image), `install.sh` and `checksums.txt` |
| Formula | `scripts/release/formula.sh` | `Formula/ky.rb` for `Yeshwanthyk/homebrew-ky`, from `checksums.txt` |
| Installer | `install.sh` | Downloads the latest (or `KY_VERSION`) release's binary, checks it against `checksums.txt`, and never replaces another program named `ky` unless told to |

## Every release

1. Set `version` in `package.json`, commit it to `main`, then tag and push:

   ```sh
   git tag v0.1.0 && git push origin v0.1.0
   ```

2. Watch the release workflow. Its `image` job says whether it kept the image or built one, and prints the lines
   that pin it in `container/image.digest`, for a checkout's builds to match. When it's done, check:

   ```sh
   brew update && brew install yeshwanthyk/ky/ky && ky --version   # ky 0.1.0 (ky-durable-cli)
   ```

   A rerun of the workflow never changes a published release: Bun doesn't build the same bytes twice, so new
   binaries wouldn't be the ones in its image. It only finishes the tap, from the release's own `checksums.txt`,
   and leaves the tap alone when it already has that version. The release stays a draft until all its files are
   up; a rerun replaces a draft an earlier run left.

A new image is a new digest, and `ky upgrade` rolls the cloud machine out (restarts it) for a new digest. So the
release builds one only when what it runs changed. When it keeps the old one, the cloud machine runs the older
`ky` binary: the same runner, but its other commands, and the release it carries, are older. It reports that
older version in its hello, which the Worker doesn't act on; the runner protocol (`PROTOCOL` in
`src/runner-protocol.ts`) is one of the image's inputs, so a protocol change always builds a new image.

## Before the first release

These are done once, on GitHub, by the owner.

1. Work merges into `main`: the workflows run from `main`, and the tag goes on it.
   Each merge also starts `deploy.yml`, which deploys your own ky with the `CLOUDFLARE_API_TOKEN` and
   `KY_OVERLAY` secrets, or does nothing and says so without them (README › Changing itself).
2. Make `Yeshwanthyk/ky-durable` public. install.sh, the brew formula and the Deploy to Cloudflare button all
   download from it signed out.
3. Create the tap: a public repo `Yeshwanthyk/homebrew-ky` with one commit (a README is enough; the workflow
   clones it, so it can't be empty).
4. Give the release workflow a deploy key that can push to the tap and nothing else. In
   `ky-durable` › Settings › Environments, create `release` (limit it to tags `v*`). Then:
   ```sh
   ssh-keygen -t ed25519 -N "" -f tap-key
   gh repo deploy-key add tap-key.pub -R Yeshwanthyk/homebrew-ky --allow-write -t "ky-durable release"
   gh secret set KY_TAP_DEPLOY_KEY -R Yeshwanthyk/ky-durable --env release < tap-key
   rm tap-key tap-key.pub
   ```
5. Once the first image is published, on GitHub › Packages › `ky-cloud` › Package settings, set its visibility to
   **Public** (deploys pull it signed out).
6. Then follow "Every release"; `package.json` is already at `0.1.0`.

## The cloud machine's image is public

`ky-cloud` is a public package (step 5): every deploy, yours or a stranger's, pulls it signed out, and
`release.yml` refuses an image it can't. Make it public as soon as it's first published.

If it's ever private, for a moment or by mistake, `ky deploy` says so and can still pull it with
`KY_GHCR_TOKEN` set to a GitHub token with **read:packages**, such as `KY_GHCR_TOKEN=$(gh auth token)` after
`gh auth refresh -s read:packages`. `deploy.yml` sends its own `GITHUB_TOKEN` the same way. A release can't
use it: strangers' deploys have no token.

## Trying it without publishing

```sh
KY_VERSION=0.1.0-local pnpm compile darwin-arm64
KY_IMAGE=$(grep -v '^#' container/image.digest) scripts/release/package.sh 0.1.0-local darwin-arm64
KY_INSTALL_BASE=$PWD/dist/out KY_INSTALL_DIR=/tmp/ky-try/bin sh install.sh
/tmp/ky-try/bin/ky --version
```

`pnpm test:node` runs install.sh and the formula script against a stand-in release (`test/node/install.test.ts`).
