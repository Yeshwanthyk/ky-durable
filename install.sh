#!/bin/sh
# Installs ky, the command that sets up and keeps your own ky on Cloudflare:
#   curl -fsSL https://github.com/Yeshwanthyk/ky-durable/releases/latest/download/install.sh | sh
# then run `ky init`. With Homebrew: brew install yeshwanthyk/ky/ky.
#
#   KY_INSTALL_DIR=<dir>   where ky goes (default ~/.local/bin)
#   KY_VERSION=<version>   a release, such as 0.1.0 (default the latest)
#   KY_INSTALL_FORCE=1     replace another program named ky in KY_INSTALL_DIR, kept as ky.replaced
#   KY_INSTALL_BASE=<url>  where the release's files are (default GitHub's); a folder works too
#
# Another program can be named ky too. This one is told apart by the name its `ky --version`
# prints, which install.sh looks for in the file without running it, so it never replaces another
# ky without being told to.
set -eu

repo=Yeshwanthyk/ky-durable
identity=ky-durable-cli

say() { printf '%s\n' "$*"; }
fail() { printf 'ky install: %s\n' "$*" >&2; exit 1; }

# The release's name for this computer. A shell under Rosetta on Apple silicon says x86_64.
os=$(uname -s)
arch=$(uname -m)
if [ "$os" = Darwin ] && [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi
case "$os-$arch" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Darwin-x86_64) platform=darwin-x64 ;;
  Linux-x86_64 | Linux-amd64) platform=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
  *) fail "there's no ky for $os $arch; ky runs on macOS and Linux, on arm64 and x64" ;;
esac

if [ -n "${KY_INSTALL_BASE:-}" ]; then base=$KY_INSTALL_BASE
elif [ -n "${KY_VERSION:-}" ]; then base=https://github.com/$repo/releases/download/v${KY_VERSION#v}
else base=https://github.com/$repo/releases/latest/download
fi

dir=${KY_INSTALL_DIR:-$HOME/.local/bin}
dir=${dir%/}
target=$dir/ky

# Whether $1 is this ky: a file holding its name, read and never run.
ours() { [ -f "$1" ] && LC_ALL=C grep -q -a -F "$identity" "$1" 2>/dev/null; }

# What $1 is, for a person deciding what to do with it.
describe() {
  where=$1
  if [ -L "$1" ]; then where="$1 -> $(readlink "$1")"; fi
  kind=$(file -b -L "$1" 2>/dev/null | cut -d, -f1 || true)
  say "  $where${kind:+ ($kind)}"
}

# A ky that isn't this one, where this one would go: never replaced unless asked.
if { [ -e "$target" ] || [ -L "$target" ]; } && ! ours "$target"; then
  if [ "${KY_INSTALL_FORCE:-}" != 1 ]; then
    {
      say "ky install: there's already a ky that isn't this one, where this one would go:"
      describe "$target"
      say ""
      say "It's left as it is. To go on, either:"
      say "  - install this ky elsewhere, and run it by its path or put that folder first on your PATH:"
      say "      curl -fsSL https://github.com/$repo/releases/latest/download/install.sh | KY_INSTALL_DIR=\$HOME/.ky-cli/bin sh"
      say "  - or replace it, keeping it as $target.replaced:"
      say "      curl -fsSL https://github.com/$repo/releases/latest/download/install.sh | KY_INSTALL_FORCE=1 sh"
    } >&2
    exit 1
  fi
  replaced=$target.replaced
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() {
  case "$base" in
    *://*) curl -fsSL -o "$tmp/$1" "$base/$1" || fail "couldn't download $base/$1" ;;
    *) cp "$base/$1" "$tmp/$1" || fail "there's no $1 in $base" ;;
  esac
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

archive=ky-$platform.tar.gz
fetch "$archive"
fetch checksums.txt
want=$(awk -v f="$archive" '$2 == f { print $1 }' "$tmp/checksums.txt")
[ -n "$want" ] && [ "$want" = "$(sha256 "$tmp/$archive")" ] || fail "$archive doesn't match the release's checksums.txt"

mkdir "$tmp/ky-unpacked"
tar -xzf "$tmp/$archive" -C "$tmp/ky-unpacked"
ours "$tmp/ky-unpacked/ky" || fail "$archive holds no ky"

mkdir -p "$dir"
if [ -n "${replaced:-}" ]; then
  mv "$target" "$replaced"
  say "Moved the other ky to $replaced"
fi
# Moved in whole, so a ky that's running keeps its file and the next run gets the new one.
cp "$tmp/ky-unpacked/ky" "$dir/.ky.installing"
chmod 755 "$dir/.ky.installing"
mv -f "$dir/.ky.installing" "$target"
say "Installed $("$target" --version) to $target"

# What `ky` runs from now on, when that isn't the one just installed.
found=$(command -v ky 2>/dev/null || true)
if [ -z "$found" ]; then
  say ""
  say "$dir isn't on your PATH. Add it, or run ky as $target:"
  say "  $target init"
elif [ "$found" != "$target" ]; then
  say ""
  if ours "$found"; then
    say "Another copy of this ky comes first on your PATH: $found"
  else
    say "Another program named ky comes first on your PATH:"
    describe "$found"
  fi
  say "So \`ky\` runs that one. Run this one as $target, or put $dir before $(dirname "$found") on your PATH:"
  say "  $target init"
else
  say ""
  say "Next: ky init"
fi
