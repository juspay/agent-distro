#!/usr/bin/env bash
# Update the sub-flake locks (test/ and doc/) after updating the root lock:
# test/ has inputs of its own — Home Manager and the Juspay profile's sources —
# which move here, and the report names them where they live.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
for dir in test doc; do
  (cd "$root/$dir" && nix flake update)
done
