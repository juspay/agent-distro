#!/usr/bin/env bash
# Release policy: tags move only forward, even if publishing a release lags.
set -euo pipefail

input=${1:?input name required}
repo=${2:?GitHub repository required}
tag_prefix=${3:-}

before=$(sed -n 's|.*'"$input"'\.url = "github:'"$repo"'/\([^"]*\)";.*|\1|p' flake.nix)
latest=$(gh release view --repo "$repo" --json tagName --jq .tagName)
for version in "$before" "$latest"; do
  if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: unusable $input release tag: $version" >&2
    exit 1
  fi
done

after="$before"
if [[ "$latest" == "$tag_prefix"* ]] && [ "$before" != "$latest" ] && [ "$(printf '%s\n' "$before" "$latest" | sort -V | tail -n1)" = "$latest" ]; then
  after="$latest"
  sed -i "s|github:$repo/$before|github:$repo/$after|" flake.nix
  grep -qF "$input.url = \"github:$repo/$after\";" flake.nix
fi

# Facts only. PR wording belongs to describe-flake-update.py.
{
  echo "before=$before"
  echo "after=$after"
  echo "latest=$latest"
  if [ -n "$tag_prefix" ]; then
    echo "tag-prefix=$tag_prefix"
  fi
} >> "$GITHUB_OUTPUT"
