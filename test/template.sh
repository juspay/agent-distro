#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
# A fresh copy of the template: a profile repository, with no flake of its own
# and nothing to build. What reads it is agent-distro itself, built here.
nix flake init -t "$root"
git init -q
system=$(nix eval --impure --raw --expr builtins.currentSystem)
distro=$(nix build --no-link --print-out-paths "$root#packages.$system.default")
AI_HARNESS=omp "$distro/bin/agent-distro" --version
# The same agent-distro.nix, read at launch: from the repository it sits in,
# and by path from anywhere. It sets no `env` or `settings`, so both reads
# cover a profile with neither.
listed=$("$distro/bin/agent-distro" --list --json)
grep -qF '"source":"repository"' <<<"$listed"
grep -qF '"name":"my-distribution"' <<<"$listed"
cd /tmp
grep -qF '"name":"my-distribution"' <<<"$(AI_PROFILE="$work" "$distro/bin/agent-distro" --list --json)"
