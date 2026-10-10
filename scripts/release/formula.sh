#!/bin/sh
# Prints the brew formula for a release, Formula/ky.rb in the tap Yeshwanthyk/homebrew-ky, from the
# release's checksums.txt (.github/workflows/release.yml):
#   scripts/release/formula.sh <version> <checksums.txt> [download base]
# The base defaults to the release's page on GitHub.
set -eu

[ $# -ge 2 ] || { echo "usage: scripts/release/formula.sh <version> <checksums.txt> [download base]" >&2; exit 2; }
version=$1
checksums=$2
base=${3:-https://github.com/Yeshwanthyk/ky-durable/releases/download/v$version}

sum() {
  value=$(awk -v f="ky-$1.tar.gz" '$2 == f { print $1 }' "$checksums")
  [ -n "$value" ] || { echo "formula: $checksums has no ky-$1.tar.gz" >&2; exit 1; }
  printf '%s' "$value"
}

darwin_arm64=$(sum darwin-arm64)
darwin_x64=$(sum darwin-x64)
linux_arm64=$(sum linux-arm64)
linux_x64=$(sum linux-x64)

cat <<FORMULA
# Written by ky's release workflow (scripts/release/formula.sh in Yeshwanthyk/ky-durable); edits here are replaced.
class Ky < Formula
  desc "Your own durable agent on your Cloudflare account"
  homepage "https://github.com/Yeshwanthyk/ky-durable"
  version "$version"

  on_macos do
    on_arm do
      url "$base/ky-darwin-arm64.tar.gz"
      sha256 "$darwin_arm64"
    end
    on_intel do
      url "$base/ky-darwin-x64.tar.gz"
      sha256 "$darwin_x64"
    end
  end

  on_linux do
    on_arm do
      url "$base/ky-linux-arm64.tar.gz"
      sha256 "$linux_arm64"
    end
    on_intel do
      url "$base/ky-linux-x64.tar.gz"
      sha256 "$linux_x64"
    end
  end

  def install
    bin.install "ky"
  end

  def caveats
    <<~EOS
      Then run: ky init

      Another program can be named ky too. If \`ky --version\` doesn't say (ky-durable-cli),
      that one comes first on your PATH: run this one as #{opt_bin}/ky, or put
      #{HOMEBREW_PREFIX}/bin before its folder on your PATH.
    EOS
  end

  test do
    assert_match "ky #{version} (ky-durable-cli)", shell_output("#{bin}/ky --version")
  end
end
FORMULA
