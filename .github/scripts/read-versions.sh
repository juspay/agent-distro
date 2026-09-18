#!/usr/bin/env bash
set -euo pipefail

codex_version=$(nix eval --raw .#codex.version)
claude_version=$(nix eval --raw .#claude.version)
printf 'codex-version=%s\nclaude-version=%s\n' "$codex_version" "$claude_version" | tee -a "$GITHUB_OUTPUT"
