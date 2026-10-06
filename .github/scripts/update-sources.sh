#!/usr/bin/env bash
# Run from the repository root; each directory owns its pin format and updater.
set -euo pipefail
shopt -s nullglob

for pins in profiles/*/npins harnesses/*/npins lib/npins lib/*/npins; do
  [ -d "$pins" ] || continue
  nix run nixpkgs#npins -- --directory "$pins" update
done

# The runtime's yaml is an npm tarball (an npins Url pin), which `npins
# update` never moves: re-pin it to npm's latest release instead.
if [ -f lib/npins/sources.json ] && jq -e '.pins.yaml' lib/npins/sources.json >/dev/null; then
  yaml=$(curl --fail --silent --show-error --location https://registry.npmjs.org/yaml/latest | jq -er .version)
  nix run nixpkgs#npins -- --directory lib/npins add tarball --name yaml "https://registry.npmjs.org/yaml/-/yaml-$yaml.tgz"
fi

for updater in harnesses/*/update.py; do
  [ -f "$updater" ] || continue
  python3 "$updater"
done
