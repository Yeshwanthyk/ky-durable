#!/bin/sh
# Refuses a deploy whose runner protocol is newer than the newest release's: the Worker would turn
# away every runner until brew ships one that speaks it, as it did in incident 1. Release the
# runner first, then deploy. Exits 1 with a ::error:: line when the commit is ahead.
#
#   scripts/release/protocol.sh [<commit>]    the commit to deploy (default HEAD); needs its v* tags fetched
set -eu

cd "$(dirname "$0")/../.."

[ $# -le 1 ] || { echo "usage: scripts/release/protocol.sh [<commit>]" >&2; exit 2; }
commit=${1:-HEAD}
file=src/machines/runner-protocol.ts

protocol_at() {
  git show "$1:$file" 2>/dev/null | sed -n 's/^export const PROTOCOL = \([0-9][0-9]*\);.*/\1/p'
}

release=$(git tag -l 'v*' --sort=-v:refname | head -n 1)
deploying=$(protocol_at "$commit")

# A rollback to before the file existed: nothing to compare, and a rollback must not be blocked.
[ -n "$deploying" ] || { echo "::notice::$commit has no PROTOCOL in $file; not checked."; exit 0; }

if [ -z "$release" ]; then
  echo "No v* release yet: runner protocol $deploying deploys."
  exit 0
fi

released=$(protocol_at "$release")

if [ -n "$released" ] && [ "$deploying" -gt "$released" ]; then
  echo "::error::This deploy speaks runner protocol $deploying, and the newest release ($release) speaks $released: every runner would be turned away. Release the runner first (push a v* tag), then deploy."
  exit 1
fi

echo "Runner protocol $deploying; the newest release ($release) speaks ${released:-an unknown one}."
