#!/usr/bin/env bash
# The chats messaging check. From the repo root: .claude/skills/verify-formal-chats/run.sh [breaks]
#   no argument: chart run (writes chart.checked.viz), the full-bound model check, then the linked tests.
#   breaks:      each broken variant of the model must fail on the property it names.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
jar="${XDG_CACHE_HOME:-$HOME/.cache}/tlaplus/tla2tools-1.7.4.jar"
cd "$here"

tlc() { java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -deadlock -cleanup -config "$1" Chats.tla; }

if [ "${1:-}" = breaks ]; then
  for cfg in Break_*.cfg; do
    out="$(tlc "$cfg" 2>&1 || true)"
    broken="$(grep -o 'Invariant [A-Za-z]* is violated' <<<"$out" | head -1 || true)"
    [ -n "$broken" ] || { echo "$cfg: NOT caught" >&2; exit 1; }
    echo "$cfg: $broken"
  done
  exit 0
fi

python3 tlc_chart.py run Chats.tla --config ChatsChart.cfg --viz chart.viz --graph-limit 100000
[ -f "$jar" ] || { echo "tlc_chart.py did not fetch $jar" >&2; exit 1; }
tlc Chats.cfg | grep -E 'states generated|No error|violated'
cd "$root" && npx vitest run --config test/invariants/vitest.config.ts test/invariants/chats-messaging
