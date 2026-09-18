#!/usr/bin/env bash
# Update test dependencies after updating the root lock.
set -euo pipefail
cd "$(dirname "$0")"
nix flake update
