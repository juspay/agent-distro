#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
nix flake init -t "$root"
git init -q
git add -A
nix flake lock --override-input agent-distro "path:$root"
system=$(nix eval --impure --raw --expr builtins.currentSystem)
nix build ".#packages.$system.default" --out-link "$work/result"
AI_HARNESS=omp nix run . -- --version
# The same agent-distro.nix, read at launch by agent-distro itself: from the
# repository, and by path from anywhere.
listed=$("$work/result/bin/agent-distro" --list --json)
grep -qF '"source":"repository"' <<<"$listed"
grep -qF '"name":"my-distribution"' <<<"$listed"
