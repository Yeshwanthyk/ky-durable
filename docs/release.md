# Releasing ky

A release is the `ky` binary for macOS and Linux on arm64 and x64. Each one carries the release it deploys: the
Worker's modules, the web app, the generic `wrangler.jsonc` and the guide for agents (`cli/release.ts`). Its
`release.json` pins all of them by digest (`bundle`), along with the cloud machine's image (`image`).

| Piece | File | What it does |
| --- | --- | --- |
| Image workflow | `.github/workflows/image.yml` | On a push to `main` that changes what the image holds, builds `container/Dockerfile` for linux/amd64, pushes `ghcr.io/<owner>/ky-cloud` by digest, and opens a pull request that pins it in `container/image.digest` with the commit it was built from (`# source: <sha>`) |
| Release workflow | `.github/workflows/release.yml` | On a tag `v<version>`: checks the tag is `package.json`'s version, and the pinned image is public and no older than what it holds. Then it runs `pnpm compile` for every platform with `KY_VERSION`, packs and publishes the GitHub release, and writes the brew formula into the tap |
| Packing | `scripts/release/package.sh` | `dist/out`: `ky-<platform>.tar.gz`, `release.json`, `install.sh` and `checksums.txt` |
| Formula | `scripts/release/formula.sh` | `Formula/ky.rb` for `Yeshwanthyk/homebrew-ky`, from `checksums.txt` |
| Installer | `install.sh` | Downloads the latest (or `KY_VERSION`) release's binary, checks it against `checksums.txt`, and never replaces another program named `ky` unless told to |

## Every release

1. Merge to `main`. If the merge changed what the image holds (`container/Dockerfile`, `cli/`, the `src/` files the
   CLI imports, `pnpm-lock.yaml`), the image workflow opens `[image] Pin ky-cloud from <sha>`. Merge it.
2. Set `version` in `package.json`, commit it to `main`, then tag and push:

   ```sh
   git tag v0.1.0 && git push origin v0.1.0
   ```

3. Watch the release workflow. When it's done, check:

   ```sh
   brew update && brew install yeshwanthyk/ky/ky && ky --version   # ky 0.1.0 (ky-durable-cli)
   ```

   A rerun of the workflow replaces the release's files, and leaves the tap alone when it already has that version.

## Before the first release

These are done once, on GitHub, by the owner.

1. Merge `setup-untether` into `main`: the workflows run from `main`, and the tag goes on it.
2. Make `Yeshwanthyk/ky-durable` public. install.sh, the brew formula and the Deploy to Cloudflare button all
   download from it signed out.
3. Create the tap: a public repo `Yeshwanthyk/homebrew-ky` with one commit (a README is enough; the workflow
   clones it, so it can't be empty).
4. Make a fine-grained token with **Contents: Read and write** on `Yeshwanthyk/homebrew-ky` only. In
   `ky-durable` › Settings › Environments, create `release` (limit it to tags `v*`), and add the token there as
   the secret `KY_TAP_TOKEN`.
5. In `ky-durable` › Settings › Actions › General › Workflow permissions, tick **Allow GitHub Actions to create
   and approve pull requests**, so the image workflow can open its pin. Without it, it pushes the branch and says
   to open the pull request by hand.
6. Run the image workflow once: Actions › image › Run workflow, on `main`. Then on GitHub › Packages ›
   `ky-cloud` › Package settings, set its visibility to **Public** (deploys pull it signed out), and merge the pin
   pull request it opened.
7. Then follow "Every release" from step 2; `package.json` is already at `0.1.0`.

## Trying it without publishing

```sh
KY_VERSION=0.1.0-local pnpm compile darwin-arm64
scripts/release/package.sh 0.1.0-local darwin-arm64
KY_INSTALL_BASE=$PWD/dist/out KY_INSTALL_DIR=/tmp/ky-try/bin sh install.sh
/tmp/ky-try/bin/ky --version
```

`pnpm test:node` runs install.sh and the formula script against a stand-in release (`test/node/install.test.ts`).
