#!/usr/bin/env bash
# Update (or pin/roll back) the atac binary pin in sources.json.
# Usage: update.sh [X.Y.Z]   (default: latest GitHub release)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
json="$here/sources.json"
base="https://github.com/Julien-cpsn/ATAC"

if [ $# -gt 0 ]; then
  new="$1"
else
  # /releases/latest redirects to /releases/tag/vX.Y.Z
  new="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$base/releases/latest" | sed 's/.*\/tag\/v//')"
fi

asset="atac-v$new-aarch64-unknown-linux-musl.tar.gz"
sum="$(nix-prefetch-url --type sha256 "$base/releases/download/v$new/$asset")"

old="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$json")"
printf '{\n  "version": "%s",\n  "sha256": "%s"\n}\n' "$new" "$sum" > "$json"

if [ "$old" = "$new" ]; then
  echo "atac $new (unchanged)"
else
  echo "atac $old -> $new"
fi
