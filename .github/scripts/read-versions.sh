#!/usr/bin/env bash
# What the pins resolve to right now, read once before the update and once
# after so the pull request can name what actually moved.
set -euo pipefail

# The update job runs on Linux, and a harness release is the same everywhere.
codex_version=$(nix eval --raw .#harnesses.x86_64-linux.codex.version)
claude_version=$(nix eval --raw .#harnesses.x86_64-linux.claude.version)
# Plugin and package sources are pinned per profile with npins, where
# `nix flake update` cannot see them.
pins=$(python3 "$(dirname "$0")/read-pins.py")
printf 'codex-version=%s\nclaude-version=%s\npins=%s\n' \
  "$codex_version" "$claude_version" "$pins" | tee -a "$GITHUB_OUTPUT"
