#!/usr/bin/env python3
"""Vendor the bun recipe from the nixpkgs that the pinned OpenCode's lock pins.

Upstream's node_modules hashes hold only for that bun. Copying its one recipe
file keeps evaluation from fetching a second nixpkgs to read it.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile


def fetch(url):
    return subprocess.check_output(
        ['curl', '--fail', '--silent', '--show-error', '--location',
         '--connect-timeout', '10', '--max-time', '60', url], text=True)


here = Path(__file__).parent
pin = json.loads((here / 'npins/sources.json').read_text())['pins']['opencode']
owner, repo = pin['repository']['owner'], pin['repository']['repo']
lock = json.loads(fetch(f'https://raw.githubusercontent.com/{owner}/{repo}/{pin["revision"]}/flake.lock'))
locked = lock['nodes'][lock['nodes'][lock['root']]['inputs']['nixpkgs']]['locked']
rev = locked['rev']
recipe = fetch(f'https://raw.githubusercontent.com/NixOS/nixpkgs/{rev}/pkgs/by-name/bu/bun/package.nix')

target = here / 'bun.nix'
content = (f'# NixOS/nixpkgs@{rev}:pkgs/by-name/bu/bun/package.nix, vendored by update.py\n'
           f'# from the nixpkgs OpenCode\'s lock pins. Do not edit.\n{recipe}')
if not target.exists() or target.read_text() != content:
    with tempfile.NamedTemporaryFile(mode='w', dir=here, delete=False) as output:
        temporary = Path(output.name)
        try:
            if target.exists():
                os.fchmod(output.fileno(), target.stat().st_mode & 0o777)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
