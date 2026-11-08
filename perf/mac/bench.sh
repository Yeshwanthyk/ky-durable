#!/usr/bin/env bash
# The Mac app's strobe bench, frozen: serves the seeded perf stack (perf/build.ts) on PORT, mints its sign-in
# token, runs perf/mac.bench.ts, and stops the stack.
#   perf/mac/bench.sh --head exe:perf/.out/mac/head/ky-mac --check
#   perf/mac/bench.sh --base exe:perf/.out/mac/base/ky-mac --head exe:perf/.out/mac/head/ky-mac
#   perf/mac/bench.sh record open --head exe:perf/.out/mac/head/ky-mac                         one case, profiled
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
port=8791
[[ -d perf/.out/state ]] || { echo "no perf stack: node --experimental-strip-types perf/build.ts" >&2; exit 2; }
node --experimental-strip-types --no-warnings perf/serve.ts "$port" > perf/.out/mac-serve.log 2>&1 &
serve=$!
trap 'kill $serve 2>/dev/null; wait $serve 2>/dev/null' EXIT
for _ in $(seq 120); do curl -sf "http://127.0.0.1:$port/manifest.webmanifest" >/dev/null && break; sleep 0.5; done
KY_URL="http://127.0.0.1:$port" node --experimental-strip-types --no-warnings apps/mac/scripts/dev-token.ts > perf/.out/mac/token
if [[ ${1:-} == record ]]; then
  strobe record --bench "perf/mac.bench.ts#$2" "${@:3}"
else
  strobe bench perf/mac.bench.ts "$@"
fi
