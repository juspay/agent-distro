#!/usr/bin/env python3
"""Publish a new pin only once every supported platform's manifest has been read, and all agree."""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

MANIFESTS = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'
PLATFORMS = [('x86_64-linux', 'linux_amd64'), ('aarch64-linux', 'linux_arm64'),
             ('aarch64-darwin', 'darwin_arm64')]


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value):
        raise ValueError(f'unusable Antigravity CLI version: {value!r}')
    return tuple(map(int, value.split('.')))


def fetch(url):
    return json.loads(subprocess.check_output(
        ['curl', '--fail', '--silent', '--show-error', '--location',
         '--connect-timeout', '10', '--max-time', '60', url], text=True))


def sri(manifest, system):
    """The manifest's hex SHA-512 as the hash fetchurl checks the tarball against."""
    digest = manifest.get('sha512')
    if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{128}', digest):
        raise ValueError(f'unusable hash for {system}: {digest!r}')
    return 'sha512-' + base64.b64encode(bytes.fromhex(digest)).decode()


source = Path(__file__).with_name('sources.json')
pinned = json.loads(source.read_text())
before = pinned['version']
version(before)
manifests = {system: fetch(f'{MANIFESTS}/{platform}.json') for system, platform in PLATFORMS}
versions = {manifest.get('version') for manifest in manifests.values()}
if len(versions) != 1:
    raise ValueError(f'the manifests disagree on the version: {sorted(map(str, versions))}')
latest = versions.pop()
version(latest)

after = before
if version(latest) > version(before):
    sources = {}
    for system, manifest in manifests.items():
        url = manifest.get('url')
        if not isinstance(url, str) or not url.startswith('https://storage.googleapis.com/antigravity-public/') \
                or f'/{latest}-' not in url:
            raise ValueError(f'unusable url for {system}: {url!r}')
        sources[system] = {'url': url, 'hash': sri(manifest, system)}
    with tempfile.NamedTemporaryFile(mode='w', dir=source.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            os.fchmod(output.fileno(), source.stat().st_mode & 0o777)
            json.dump({'version': latest, 'sources': sources}, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
            temporary.replace(source)
        finally:
            temporary.unlink(missing_ok=True)
    after = latest

with Path(os.environ.get('GITHUB_OUTPUT', '/dev/stdout')).open('a') as output:
    output.write(f'before={before}\nafter={after}\nlatest={latest}\n')
