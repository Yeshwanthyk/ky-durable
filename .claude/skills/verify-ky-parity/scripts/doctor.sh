#!/usr/bin/env bash
# Read-only preflight for verify-ky-parity: is this checkout safe and ready to prove a domain?
# Usage: .claude/skills/verify-ky-parity/scripts/doctor.sh [domain]
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
fail=0
ok() { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] && ok "node $(node --version)" || bad "node 22+ needed for --experimental-strip-types (have $(node --version))"
test -x node_modules/.bin/vitest && ok "dependencies installed" || bad "node_modules missing: pnpm install --offline"
[ "$(git rev-parse effect-baseline 2>/dev/null)" = "$(git rev-parse b658a6e 2>/dev/null)" ] && ok "B = effect-baseline = b658a6e" || bad "tag effect-baseline missing or not b658a6e"
pnpm -s effect:pin >/dev/null 2>&1 && ok "effect pinned (package.json, lockfile, vendor/effect agree)" || bad "pnpm effect:pin fails"
pnpm -s ledger >/dev/null 2>&1 && ok "prune ledger holds against gate-baseline.json" || bad "pnpm ledger fails"
node -e 'const b=require("./gate-baseline.json");const f=b.items.filter(i=>!["harness","web"].includes(i.check)&&!i.file).length;process.exit(f?1:0)' \
  && ok "gate-baseline.json items carry their files" || bad "gate-baseline.json predates per-file items: re-record at B"

if [ -n "${1:-}" ]; then
  d=$1
  test -d "test/parity/$d/mutants" && ok "$d has mutants: $(ls test/parity/$d/mutants | tr '\n' ' ')" || bad "$d has no test/parity/$d/mutants/"
  dirty=$(git status --porcelain -- src cli | head -5)
  [ -z "$dirty" ] && ok "src/ and cli/ clean (a mutant run patches them)" || bad "uncommitted changes under src/ or cli/: commit them before --mutant: $dirty"
fi

# Never a live ky: nothing here may be pointed at Cloudflare.
[ -z "${CLOUDFLARE_API_TOKEN:-}" ] && ok "no CLOUDFLARE_API_TOKEN in the environment" || bad "CLOUDFLARE_API_TOKEN is set: unset it; proofs run only against the fake"
exit $fail
