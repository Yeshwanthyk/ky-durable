#!/usr/bin/env bash
# The setup-untether DAG (docs/setup-plan.md).
#   scripts/dag.sh status        what's done, ready, or blocked
#   scripts/dag.sh start <id>    worktree + branch for a ready node, then a Claude Code session on it
# A node is done when a commit on origin/setup-untether starts with "[<id>]".
set -euo pipefail

BASE=setup-untether
ROOT=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
WORKTREES=${KY_WORKTREES:-$(dirname "$ROOT")/ky-dag}

deps() {
  case $1 in
    R1|R2|R3) echo "" ;;
    M) echo "R2" ;;
    T) echo "R1 R3" ;;
    X) echo "R1" ;;
    D) echo "R2" ;;
    A) echo "T" ;;
    P) echo "R1 M" ;;
    K) echo "M R3" ;;
    S) echo "R3 T X" ;;
    C) echo "D T P" ;;
    F) echo "M K S" ;;
    CM) echo "D S C" ;;
    RT) echo "CM" ;;
    REL) echo "A C CM D" ;;
    *) echo "unknown node: $1" >&2; exit 2 ;;
  esac
}
NODES="R1 R2 R3 M T X D A P K S C F CM RT REL"

ref() { git -C "$ROOT" rev-parse --verify -q "origin/$BASE" >/dev/null && echo "origin/$BASE" || echo "$BASE"; }
done_() { git -C "$ROOT" log "$(ref)" --format=%s | grep "^\[$1\]" >/dev/null; }  # no -q: an early exit SIGPIPEs git log under pipefail
ready() { for d in $(deps "$1"); do done_ "$d" || return 1; done; }

status() {
  git -C "$ROOT" fetch -q origin "$BASE" 2>/dev/null || true
  for n in $NODES; do
    if done_ "$n"; then s="done"
    elif ready "$n"; then s="ready"
    else s="blocked on: $(for d in $(deps "$n"); do done_ "$d" || printf '%s ' "$d"; done)"
    fi
    printf '%-4s %s\n' "$n" "$s"
  done
}

start() {
  local n=$1
  deps "$n" >/dev/null
  git -C "$ROOT" fetch -q origin "$BASE" 2>/dev/null || true
  done_ "$n" && { echo "$n is already merged into $BASE"; exit 1; }
  ready "$n" || { echo "$n is blocked; run: scripts/dag.sh status"; exit 1; }
  local dir="$WORKTREES/$n" branch="setup/$n"
  if [ ! -d "$dir" ]; then
    git -C "$ROOT" worktree add -b "$branch" "$dir" "$(ref)"
    (cd "$dir" && pnpm install --frozen-lockfile >/dev/null)
  fi
  cd "$dir"
  exec claude "You are building node $n of the ky setup plan, on branch $branch in this worktree.

1. Read docs/setup-plan.md in full: the Rules, Contracts and the '### $n.' section. Read FEATURES.md and the code the section cites. Its dependencies ($(deps "$n")) are already merged here.
2. Build exactly that node. Follow the contracts; if one must change, change it in docs/setup-plan.md in this PR and say why in the PR description.
3. Keep today's UI quality and stack: extend the existing panels and components, no new UI libraries.
4. Before the PR: pnpm typecheck, pnpm lint, pnpm test, pnpm gate all green; FEATURES.md rows updated for every behaviour you changed.
5. Commit, push $branch, and open a PR into $BASE with gh. The PR title MUST start with '[$n] '. Squash-merge keeps that prefix, which is how scripts/dag.sh knows the node is done.
6. List anything you deferred or found wrong in the plan in the PR description.

Start by summarising the node back to me in a few lines and listing the files you expect to touch, then build it."
}

case ${1:-status} in
  status) status ;;
  start) [ $# -eq 2 ] || { echo "usage: scripts/dag.sh start <id>"; exit 2; }; start "$2" ;;
  *) echo "usage: scripts/dag.sh status | start <id>"; exit 2 ;;
esac
