#!/usr/bin/env bash
# Copy freshly built circuits into circuits/ under their content-addressed names.
# Existing files are never overwritten; a new hash means a new file.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p circuits
for f in build/*.arcis; do
  name=$(basename "$f" .arcis)
  tag=$(shasum -a 256 "$f" | cut -c1-8)
  out="circuits/${name}-${tag}.arcis"
  if [ -e "$out" ]; then
    echo "unchanged  $out"
  else
    cp "$f" "$out"
    echo "published  $out"
  fi
done
