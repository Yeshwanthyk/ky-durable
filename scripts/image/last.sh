#!/bin/sh
# The cloud machine's image a release starts from, as `ref=…`, `source=…` and `from=…` lines (for
# $GITHUB_OUTPUT): the image the newest published release deploys, which is what `ky upgrade`
# compares against. This tag's own release first, so a rerun keeps the image its first run
# published; then the newest release that names one; then container/image.digest, the pin a
# checkout builds with. With no tag (deploy.yml), the newest release that names one. Drafts never count: a draft is a run that failed, whose binaries a rerun
# builds again. `source` is the commit the image was built from, by its own label; empty when unknown.
#
#   scripts/image/last.sh [<tag>]    needs gh (signed in, GH_TOKEN in Actions), curl and jq
set -eu

cd "$(dirname "$0")/../.."

[ $# -le 1 ] || { echo "usage: scripts/image/last.sh [<tag>]" >&2; exit 2; }
tag=${1:-}

image_of() {
  gh release download "$1" --pattern release.json --output - 2>/dev/null | jq -r '.image // empty' 2>/dev/null || true
}

published=$(gh api "repos/{owner}/{repo}/releases?per_page=30" --jq '.[] | select(.draft | not) | .tag_name')
ref=

if [ -n "$tag" ] && printf '%s\n' "$published" | grep -qxF "$tag"; then
  ref=$(image_of "$tag")
  from="$tag (this tag's release: a rerun)"
fi

if [ -z "$ref" ]; then
  for each in $published; do
    ref=$(image_of "$each")
    if [ -n "$ref" ]; then from="$each, the newest release that names one"; break; fi
  done
fi

if [ -z "$ref" ]; then
  ref=$(sed -e '/^#/d' -e '/^[[:space:]]*$/d' container/image.digest 2>/dev/null | head -n 1 | tr -d '[:space:]')
  from=container/image.digest
fi

source=
[ -z "$ref" ] || source=$(scripts/image/registry.sh source "$ref") || source=

echo "ref=$ref"
echo "source=$source"
echo "from=$from"
