#!/bin/sh
# Packs what `KY_VERSION=<version> pnpm compile` built into the files a release publishes, in
# dist/out (.github/workflows/release.yml):
#   ky-<platform>.tar.gz   the `ky` binary for each platform, with the release inside it
#   release.json           what this release deploys: the Worker bundle's digest and the image. The
#                          binaries' own release.json names this file, not the image, which holds
#                          the linux-x64 binary (cli/release.ts); KY_IMAGE=<ref> is the image
#   install.sh             the installer, which takes the latest release's binary
#   checksums.txt          sha-256 of each of them; install.sh and the brew formula check against it
#
#   KY_IMAGE=ghcr.io/…@sha256:… scripts/release/package.sh <version> [platform …]   (default: all four)
set -eu

cd "$(dirname "$0")/../.."

[ $# -ge 1 ] || { echo "usage: scripts/release/package.sh <version> [platform …]" >&2; exit 2; }
version=$1
shift
[ $# -gt 0 ] || set -- darwin-arm64 darwin-x64 linux-x64 linux-arm64

fail() { echo "package: $*" >&2; exit 1; }

built=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("dist/release/release.json", "utf8")).version)') \
  || fail "there's no dist/release/release.json: run KY_VERSION=$version pnpm compile"
[ "$built" = "$version" ] || fail "dist/release is $built, not $version: run KY_VERSION=$version pnpm compile"

out=dist/out
stage=dist/stage
rm -rf "$out" "$stage"
mkdir -p "$out"

for platform in "$@"; do
  [ -f "dist/bin/ky-$platform" ] || fail "there's no dist/bin/ky-$platform"
  mkdir -p "$stage/$platform"
  cp "dist/bin/ky-$platform" "$stage/$platform/ky"
  chmod 755 "$stage/$platform/ky"
  tar -czf "$out/ky-$platform.tar.gz" -C "$stage/$platform" ky
done
rm -rf "$stage"

# The binaries' release.json, with the image: `ky deploy` checks it's the same release by its version and bundle.
# shellcheck disable=SC2016 # JavaScript, not shell.
KY_IMAGE=${KY_IMAGE:-} node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync("dist/release/release.json", "utf8"));
  const image = process.env.KY_IMAGE;
  if (manifest.imageFrom && !image) { console.error("package: the binaries read their image from the release: set KY_IMAGE=<ref>"); process.exit(1); }
  if (image && !/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._\/-]+@sha256:[0-9a-f]{64}$/.test(image)) { console.error(`package: KY_IMAGE is ${image}, not ghcr.io/…@sha256:…`); process.exit(1); }
  fs.writeFileSync(process.argv[1], JSON.stringify(image ? { ...manifest, image } : manifest, null, 2));
' "$out/release.json"
cp install.sh "$out/install.sh"

if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$@"; }; else sum() { shasum -a 256 "$@"; }; fi
(cd "$out" && sum ky-*.tar.gz release.json install.sh > checksums.txt)

echo "Packed ky $version in $out:"
ls -l "$out"
