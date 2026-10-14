#!/usr/bin/env bash
# Run from the repository root; each directory owns its pin format and updater.
set -euo pipefail
shopt -s nullglob

for pins in harnesses/*/npins lib/npins lib/*/npins; do
  [ -d "$pins" ] || continue
  nix run nixpkgs#npins -- --directory "$pins" update
done

# An npm tarball pinned as an npins Url pin never moves with `npins update`.
# Re-pin it to the newest release of the major it is on: a new major is a
# reviewed change, not a daily one. yaml's Document API is what
# src/harness/omp.ts reads, and the OpenCode plugin owns the model discovery
# of the LiteLLM server a profile points it at.
pin_npm() {
  local name=$1 pins=$2 pinned major newest
  # Unreadable or malformed JSON stops the update; only a missing pin skips.
  [ -f "$pins/sources.json" ] || return 0
  pinned=$(jq -r --arg name "$name" '.pins[$name].url // ""' "$pins/sources.json")
  [ -n "$pinned" ] || return 0
  major=$(printf '%s\n' "$pinned" | sed -nE "s|.*/${name}-([0-9]+)\\.[0-9]+\\.[0-9]+\\.tgz\$|\\1|p")
  if [ -z "$major" ]; then
    echo "update-sources.sh: cannot read the $name pin's version from $pinned" >&2
    exit 1
  fi
  newest=$(curl --fail --silent --show-error --location \
    --header 'Accept: application/vnd.npm.install-v1+json' "https://registry.npmjs.org/$name" \
    | jq -er --arg major "$major" '[.versions | keys[] | select(test("^" + $major + "\\.[0-9]+\\.[0-9]+$"))
        | split(".") | map(tonumber)] | max | map(tostring) | join(".")')
  nix run nixpkgs#npins -- --directory "$pins" add tarball --name "$name" \
    "https://registry.npmjs.org/$name/-/$name-$newest.tgz"
}

pin_npm yaml lib/npins
pin_npm opencode-plugin-litellm harnesses/opencode/npins

for updater in harnesses/*/update.py; do
  [ -f "$updater" ] || continue
  python3 "$updater"
done
