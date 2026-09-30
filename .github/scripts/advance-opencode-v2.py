#!/usr/bin/env python3
"""Publish a new pin only once every supported platform has been fetched."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value):
        raise ValueError(f'unusable OpenCode v2 version: {value!r}')
    return tuple(map(int, value.split('.')))


def fetch(url):
    return json.loads(subprocess.check_output(
        ['curl', '--fail', '--silent', '--show-error', '--location',
         '--connect-timeout', '10', '--max-time', '60', url], text=True))


source = Path('pkgs/opencode-v2/sources.json')
pinned = json.loads(source.read_text())
before = pinned['version']
version(before)
try:
    latest = fetch('https://opencode.ai/update/api/latest/cli/npm')['version']
    version(latest)
except (subprocess.SubprocessError, ValueError, KeyError, TypeError):
    latest = fetch('https://registry.npmjs.org/@opencode/cli-linux-x64/dist-tags')['latest']

after = before
if version(latest) > version(before):
    hashes = {}
    for system, target in [('x86_64-linux', 'linux-x64'), ('aarch64-linux', 'linux-arm64'),
                           ('aarch64-darwin', 'darwin-arm64')]:
        url = f'https://registry.npmjs.org/@opencode/cli-{target}/-/cli-{target}-{latest}.tgz'
        result = json.loads(subprocess.check_output(
            ['nix', 'store', 'prefetch-file', '--json', url], text=True))
        digest = result['hash']
        if not isinstance(digest, str) or not re.fullmatch(r'sha256-[A-Za-z0-9+/]{43}=', digest):
            raise ValueError(f'unusable hash for {system}: {digest!r}')
        hashes[system] = digest
    with tempfile.NamedTemporaryFile(mode='w', dir=source.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            os.fchmod(output.fileno(), source.stat().st_mode & 0o777)
            json.dump({'version': latest, 'hashes': hashes}, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
            temporary.replace(source)
        finally:
            temporary.unlink(missing_ok=True)
    after = latest

with Path(os.environ.get('GITHUB_OUTPUT', '/dev/stdout')).open('a') as output:
    output.write(f'before={before}\nafter={after}\nlatest={latest}\n')
