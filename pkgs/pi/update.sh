#!/usr/bin/env bash
# Update (or pin/roll back) the pi binary pin in sources.json.
# Usage: update.sh [X.Y.Z]   (default: latest GitHub release)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
json="$here/sources.json"
base="https://github.com/earendil-works/pi"

if [ $# -gt 0 ]; then
  new="$1"
else
  # /releases/latest redirects to /releases/tag/vX.Y.Z
  new="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$base/releases/latest" | sed 's/.*\/tag\/v//')"
fi

sums="$(curl -fsSL "$base/releases/download/v$new/SHA256SUMS")"
sum="$(echo "$sums" | awk '$2 == "pi-linux-arm64.tar.gz" { print $1 }')"

if [ -z "$sum" ]; then
  echo "error: could not read pi-linux-arm64.tar.gz sha256 from v$new SHA256SUMS" >&2
  exit 1
fi

old="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$json")"
printf '{\n  "version": "%s",\n  "sha256": "%s"\n}\n' "$new" "$sum" > "$json"

if [ "$old" = "$new" ]; then
  echo "pi $new (unchanged)"
else
  echo "pi $old -> $new"
fi
