#!/usr/bin/env bash
# Builds the Mac app from this checkout as strobe times it (release, line tables, not stripped) and stages it as
# a variant: perf/.out/mac/<name>/ky-mac.   perf/mac/stage.sh head
set -euo pipefail
name="${1:?usage: perf/mac/stage.sh <variant name>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/perf/.out/mac/$name"
(cd "$root/apps/mac" && CARGO_PROFILE_RELEASE_DEBUG=line-tables-only CARGO_PROFILE_RELEASE_STRIP=false cargo build --release -q)
mkdir -p "$out"
cp "$root/apps/mac/target/release/ky-mac" "$out/ky-mac-bin"
cp "$root/perf/mac/launch.sh" "$out/ky-mac"
chmod +x "$out/ky-mac"
identity="$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ {print $2; exit}')"
[[ -n "$identity" ]] && codesign --force --identifier ky-mac --sign "$identity" "$out/ky-mac-bin" 2>/dev/null
echo "staged $out/ky-mac"
