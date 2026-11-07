#!/usr/bin/env bash
# The looks claim check. From the repo root: .claude/skills/verify-formal-looks/run.sh [breaks]
#   no argument: every rule on the code's model, compared with chart.viz (writes chart.checked.viz), then the linked tests.
#   breaks:      each broken variant must fail.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
cd "$here"

if [ "${1:-}" = breaks ]; then
  for cfg in Break_*.cfg; do
    if python3 tlc_chart.py run Looks.tla --config "$cfg" >"/tmp/looks-$cfg.log" 2>&1; then echo "$cfg: NOT caught" >&2; exit 1; fi
    echo "$cfg: $(grep -E ': broken' "/tmp/looks-$cfg.log" | head -1 | sed 's/^ *//')"
  done
  exit 0
fi

python3 tlc_chart.py run Looks.tla --config Looks.cfg --viz chart.viz
cd "$root" && npx vitest run --config test/invariants/vitest.config.ts test/invariants/pace test/invariants/look-events
