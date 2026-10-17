#!/bin/sh
# verify-ky-machines live check: read-only. Reports every runner on this computer (one per
# deployment), what it says about itself, whether that is true, orphaned or silent agents, and
# reconnects. Changes nothing; the only network calls are a GET of each Worker's manifest.
#
#   sh .claude/skills/verify-ky-machines/live.sh
set -u
STATE="${KY_STATE_DIR:-$HOME/.ky}"
now=$(date +%s)

echo "== binary"
printf '   ky on PATH                                   %s\n' "$(command -v ky || echo none)"
printf '   ky --version                                 %s\n' "$(ky --version 2>/dev/null || echo unknown)"

for status in "$STATE/runner-status.json" "$STATE"/*/runner-status.json; do
  [ -f "$status" ] || continue
  dir=$(dirname "$status")
  name=$( [ "$dir" = "$STATE" ] && echo default || basename "$dir")
  label=$( [ "$name" = default ] && echo dev.ky.runner || echo "dev.ky.runner.$name")
  echo
  echo "== runner $name ($dir)"
  # Field by field: no jq dependency.
  field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$status"; }
  state=$(field state); pid=$(field pid); at=$(field at); url=$(field url); version=$(field version); reason=$(field reason)
  age=$(( now - ${at:-0} / 1000 ))
  printf '   status file says                             %s%s (written %ss ago)\n' "$state" "${reason:+ ($reason)}" "$age"
  printf '   worker / runner version                      %s / %s\n' "$url" "$version"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then pidok=alive; else pidok=dead; fi
  printf '   status pid %-8s                          %s\n' "$pid" "$pidok"
  [ "$state" = online ] && [ "$pidok" = dead ] && echo "   GAP   status says online but its process is gone"
  ld=$(launchctl print "gui/$(id -u)/$label" 2>/dev/null)
  if [ -n "$ld" ]; then
    printf '   launchd %-36s state=%s pid=%s last exit=%s\n' "$label" \
      "$(echo "$ld" | sed -n 's/^[[:space:]]*state = //p' | head -1)" \
      "$(echo "$ld" | sed -n 's/^[[:space:]]*pid = //p' | head -1)" \
      "$(echo "$ld" | sed -n 's/^[[:space:]]*last exit code = //p' | head -1)"
  else
    printf '   launchd %-36s not loaded\n' "$label"
  fi
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code} in %{time_total}s' "$url/manifest.webmanifest" 2>/dev/null)
  printf '   GET worker manifest                          %s\n' "$code"
  log="$dir/runner.log"
  if [ -f "$log" ]; then
    printf '   log disconnects (1006) / connects / goodbyes %s / %s / %s\n' \
      "$(grep -c 'disconnected (1006' "$log")" "$(grep -c 'connected to ' "$log")" "$(grep -c 'said goodbye' "$log")"
    # A runner from before the logs had dates writes only HH:MM:SS (UTC).
    dated=$(tail -1 "$log" | grep -Eo '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z' || true)
    printf '   log last line dated                          %s\n' "${dated:-no (HH:MM:SS only, an older runner)}"
    printf '   log stops (SIGTERM/SIGINT) logged             %s\n' "$(grep -cE 'SIG(TERM|INT): stopping' "$log")"
    printf '   connects with no disconnect before (restarts) %s\n' \
      "$(awk '/connected to /{ if (prev=="c") n++; prev="c" } /disconnected/{prev="d"} END{print n+0}' "$log")"
    printf '   agent exits with null (killed)               %s\n' "$(grep -c ': exit null' "$log")"
    last=$(grep 'said goodbye' "$log" | tail -1)
    [ -n "$last" ] && printf '   last goodbye                                 %s\n' "$last"
  fi
  # This runner's agent children: running long with almost no CPU is how today's hang looked.
  if [ "$pidok" = alive ]; then
    ps -o pid=,etime=,time=,command= -g "$(ps -o pgid= -p "$pid" | tr -d ' ')" 2>/dev/null | awk -v runner="$pid" '
      $1 != runner && ($4 ~ /claude$/ || $4 ~ /codex$/) { print "   child " $1 " up " $2 " cpu " $3 "  " $4 }'
  fi
done

echo
echo "== orphaned task agents (parent is launchd, started by a ky runner)"
# The bench's fake agents (test/fakes/) are left out: its restart probe orphans one on purpose.
ps -axo pid=,ppid=,etime=,time=,command= | awk '
  $2 == 1 && /append-system-prompt You are running a task for ky/ && !/test\/fakes\// { print "   GAP   orphan pid " $1 " up " $3 " cpu " $4; n++ }
  END { if (n == 0) print "   none" }'
