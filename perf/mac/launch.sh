#!/usr/bin/env bash
# What strobe launches for a build of the Mac app (perf/mac/stage.sh copies it in beside the binary as
# `ky-mac`): the app signed in to the perf stack perf/mac/bench.sh serves, with the token it minted.
here="$(cd "$(dirname "$0")" && pwd)"
export KY_READY_LINE=1
export KY_TOKEN="$(cat "$here/../token")"
exec "$here/ky-mac-bin" "$@"
