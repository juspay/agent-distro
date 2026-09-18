#!/usr/bin/env bash
# Update dependencies from the checkout, keeping the parent reference portable.
set -euo pipefail
cd "$(dirname "$0")"
nix flake update --override-input agent-distro path:..
# CLI path overrides become absolute snapshots. The parent is instead part of
# this same source tree: use Nix's relative-input lock representation so the
# committed lock neither contains a developer's path nor hashes itself.
python3 - <<'PY'
import json
from pathlib import Path
path = Path('flake.lock')
lock = json.loads(path.read_text())
node = lock['nodes']['agent-distro']
node['locked'] = {'path': '..', 'type': 'path'}
node['original'] = {'owner': 'juspay', 'repo': 'agent-distro', 'type': 'github'}
node['parent'] = []
path.write_text(json.dumps(lock, indent=2) + '\n')
PY
