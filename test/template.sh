#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
nix flake init -t "$root"
nix flake lock --override-input agent-distro "path:$root" \
  --override-input my-skills "path:$root/test/fixtures/my-skills"
system=$(nix eval --impure --raw --expr builtins.currentSystem)
nix build ".#packages.$system.default" --out-link "$work/result"
AI_HARNESS=omp nix run . -- --version
