#!/usr/bin/env bash
# Run from the repository root; each directory owns its pin format and updater.
set -euo pipefail
shopt -s nullglob

for pins in harnesses/*/npins lib/npins lib/*/npins; do
  [ -d "$pins" ] || continue
  nix run nixpkgs#npins -- --directory "$pins" update
done

# The runtime's yaml is an npm tarball (an npins Url pin), which `npins
# update` never moves. Re-pin it to the newest release of the major it is on:
# a new major can change the Document API src/harness/omp.ts relies on, so
# crossing one is a reviewed change, not a daily one.
if [ -f lib/npins/sources.json ]; then
  # Unreadable or malformed JSON stops the update; only a missing pin skips.
  pinned=$(jq -r '.pins.yaml.url // ""' lib/npins/sources.json)
  if [ -n "$pinned" ]; then
    major=$(printf '%s\n' "$pinned" | sed -nE 's|.*/yaml-([0-9]+)\.[0-9]+\.[0-9]+\.tgz$|\1|p')
    if [ -z "$major" ]; then
      echo "update-sources.sh: cannot read the yaml pin's version from $pinned" >&2
      exit 1
    fi
    yaml=$(curl --fail --silent --show-error --location \
      --header 'Accept: application/vnd.npm.install-v1+json' https://registry.npmjs.org/yaml \
      | jq -er --arg major "$major" '[.versions | keys[] | select(test("^" + $major + "\\.[0-9]+\\.[0-9]+$"))
          | split(".") | map(tonumber)] | max | map(tostring) | join(".")')
    nix run nixpkgs#npins -- --directory lib/npins add tarball --name yaml "https://registry.npmjs.org/yaml/-/yaml-$yaml.tgz"
  fi
fi

for updater in harnesses/*/update.py; do
  [ -f "$updater" ] || continue
  python3 "$updater"
done
