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
# The same plugin.json profile, read at launch: from the repository it sits in,
# and by path from anywhere. It sets no `env` or `settings`, so both reads
# cover a profile with neither.
listed=$("$distro/bin/agent-distro" --list --json)
grep -qF '"source":"repository"' <<<"$listed"
grep -qF '"name":"my-distribution"' <<<"$listed"
cd /tmp
grep -qF '"name":"my-distribution"' <<<"$(AI_PROFILE="$work" "$distro/bin/agent-distro" --list --json)"
# mkProfile locks a flake-reference plugin when it builds the profile — here a
# `path:` one with a `dir`, which needs no network — and the built profile
# names it by the store path it was locked to, so a launch fetches nothing.
# Only an impure evaluation may lock; test/test-mk-profile.nix covers the
# refusal in a pure one.
mkdir -p "$work/locked"
cat > "$work/locked/plugin.json" <<JSON
{
  "\$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "locked",
  "extensions": { "asia.nixos.agent-distro": { "plugins": ["path:$root/test?dir=fixtures/profile"] } }
}
JSON
built=$(nix build --impure --no-link --print-out-paths --expr "
  (builtins.getFlake \"path:$root\").lib.mkProfile {
    system = \"$system\";
    profile = \"$work/locked\";
  }")
root0=$(readlink "$built/share/agent-distro/plugins/0/root")
test "$root0" = "$work/locked" || case "$root0" in
  /nix/store/*-locked) ;;
  *) echo "mkProfile did not make the profile's own directory plugins/0: $root0" >&2; exit 1 ;;
esac
root1=$(readlink "$built/share/agent-distro/plugins/1/root")
case "$root1" in
  /nix/store/*-source/fixtures/profile) ;;
  *) echo "mkProfile did not lock the path: reference; plugins/1/root is $root1" >&2; exit 1 ;;
esac
test -f "$root1/plugin.json"
grep -qF '"name":"locked"' <<<"$(AI_PROFILE="$built" "$distro/bin/agent-distro" --list --json)"
