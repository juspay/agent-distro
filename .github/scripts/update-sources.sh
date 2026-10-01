#!/usr/bin/env bash
# Run from the repository root; each directory owns its pin format and updater.
set -euo pipefail
shopt -s nullglob

for pins in profiles/*/npins harnesses/*/npins lib/npins lib/*/npins; do
  [ -d "$pins" ] || continue
  nix run nixpkgs#npins -- --directory "$pins" update
done

for updater in harnesses/*/update.py; do
  [ -f "$updater" ] || continue
  python3 "$updater"
done
