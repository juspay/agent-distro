#!/usr/bin/env bash
# One evaluation, including harnesses added without editing this script.
set -euo pipefail
nix eval --json .#harnesses.x86_64-linux --apply 'builtins.mapAttrs (_: p: p.version)'
