#!/usr/bin/env bash
# Regenerate a mutant whose patch no longer applies because the code it breaks moved.
#   mutant.sh <domain> <name> open   applies the patch with a 3-way merge; fix any conflict markers by hand
#   mutant.sh <domain> <name> save   writes the working tree's src/ and cli/ changes back as the patch, then restores them
# Then rerun `pnpm parity <domain> --mutant <name>`: it must still be caught.
set -euo pipefail
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false
cd "$(git rev-parse --show-toplevel)"
domain=${1:?usage: mutant.sh <domain> <name> open|save}
name=${2:?usage: mutant.sh <domain> <name> open|save}
patch=test/parity/$domain/mutants/$name.patch

case ${3:-} in
  open)
    test -f "$patch" || { echo "no $patch" >&2; exit 1; }
    [ -z "$(git status --porcelain -- src cli)" ] || { echo "src/ or cli/ has changes: commit them first" >&2; exit 1; }
    git apply --3way "$patch" || echo "conflicts: resolve the markers under src/ or cli/, then run: mutant.sh $domain $name save"
    ;;
  save)
    [ -n "$(git diff HEAD -- src cli)" ] || { echo "no change under src/ or cli/ to save" >&2; exit 1; }
    ! git diff HEAD --check -- src cli | grep -q 'conflict marker' || { echo "conflict markers left" >&2; exit 1; }
    git diff HEAD -- src cli >"$patch"
    git reset -q -- src cli
    git checkout -- src cli
    echo "saved $patch; now: pnpm parity $domain --mutant $name"
    ;;
  *) echo "usage: mutant.sh <domain> <name> open|save" >&2; exit 1 ;;
esac
