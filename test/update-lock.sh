#!/usr/bin/env bash
# Update the sub-flake locks (test/ and doc/) after updating the root lock.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
for dir in test doc; do
  (cd "$root/$dir" && nix flake update)
done
