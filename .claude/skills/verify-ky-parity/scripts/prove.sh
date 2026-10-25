#!/usr/bin/env bash
# A domain's proof, checks 1 to 3, in order, stopping at the first red:
#   doctor → ratchet (B's tests in the domain's files still hold) → parity/invariants at the bar → every mutant caught.
# Usage: .claude/skills/verify-ky-parity/scripts/prove.sh <domain> [--runs N] [--seed S]
# Evidence: test-results/parity/<domain>/{ratchet,proof,mutant-*}.json and test-results/census/<domain>.json.
# While src/<domain>/legacy/ exists, the evidence is also kept as test-results/parity/<domain>-pre-flip/, which the flip's own run doesn't overwrite.
set -euo pipefail
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false
cd "$(git rev-parse --show-toplevel)"
domain=${1:?usage: prove.sh <domain> [--runs N] [--seed S]}
shift
here=.claude/skills/verify-ky-parity/scripts

echo "== doctor";  bash "$here/doctor.sh" "$domain"
echo "== ratchet"; node --experimental-strip-types --no-warnings "$here/ratchet.ts" "$domain"
echo "== proof";   pnpm -s parity "$domain" "$@"
echo "== mutants"; pnpm -s parity "$domain" --mutant all --runs 100 --steps 30
if [ -d "src/$domain/legacy" ]; then rm -rf "test-results/parity/$domain-pre-flip"; cp -R "test-results/parity/$domain" "test-results/parity/$domain-pre-flip"; fi
echo "PASS  $domain: ratchet, proof and mutants. Evidence: test-results/parity/$domain/"
