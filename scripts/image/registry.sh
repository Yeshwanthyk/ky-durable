#!/bin/sh
# Asks GitHub's registry about the cloud machine's image, signed out, as every deploy pulls it:
#
#   scripts/image/registry.sh public <ref>   fails unless ghcr.io serves <ref> to anyone
#   scripts/image/registry.sh source <ref>   prints the commit it was built from: its
#                                            org.opencontainers.image.revision label
#
# <ref> is ghcr.io/<owner>/<name>@sha256:<digest>. Needs curl and jq.
set -eu

[ $# -eq 2 ] || { echo "usage: scripts/image/registry.sh public|source <ref>" >&2; exit 2; }
what=$1
ref=$2

printf '%s' "$ref" | grep -Eq '^ghcr\.io/[a-z0-9._-]+/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$' \
  || { echo "registry: $ref isn't ghcr.io/<owner>/<name>@sha256:<digest>" >&2; exit 1; }
repository=${ref%@*}
repository=${repository#ghcr.io/}
digest=${ref#*@}

token=$(curl -fsSL "https://ghcr.io/token?scope=repository:$repository:pull" | jq -r .token) || token=
[ -n "$token" ] && [ "$token" != null ] || { echo "registry: ghcr.io gives no signed-out token for $repository" >&2; exit 1; }

get() {
  curl -fsSL -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/$repository/$1"
}

manifest=$(get "manifests/$digest") || { echo "registry: $ref can't be pulled signed out" >&2; exit 1; }

case $what in
  public) echo "$ref is public" ;;
  source)
    # An index (none of image.yml's or release.yml's are): its linux/amd64 manifest.
    amd64=$(printf '%s' "$manifest" | jq -r '.manifests // [] | map(select(.platform.os == "linux" and .platform.architecture == "amd64")) | .[0].digest // empty')
    [ -z "$amd64" ] || manifest=$(get "manifests/$amd64")
    config=$(printf '%s' "$manifest" | jq -r .config.digest)
    get "blobs/$config" | jq -r '.config.Labels["org.opencontainers.image.revision"] // empty' | grep -E '^[0-9a-f]{7,40}$' \
      || { echo "registry: $ref has no org.opencontainers.image.revision label" >&2; exit 1; }
    ;;
  *) echo "usage: scripts/image/registry.sh public|source <ref>" >&2; exit 2 ;;
esac
