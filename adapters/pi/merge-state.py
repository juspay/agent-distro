"""Merge Pi state: ours replace ours, user entries stay untouched,
and invalid JSON aborts before any write.
"""
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def read_object(path):
    data = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(data, dict):
        raise ValueError(f'{path} must contain a JSON object')
    return data


def object_field(data, key):
    value = data.setdefault(key, {})
    if not isinstance(value, dict):
        raise ValueError(f'{key} must be a JSON object')
    return value


def prepare(directory, fragment, gateway):
    paths = {name: (Path(directory) / f'{name}.json').resolve()
             for name in ['mcp', 'settings'] + (['models'] if gateway else [])}
    # Validate every input before any write, including files another merge owns.
    data = {name: read_object(path) for name, path in paths.items()}
    servers = data['mcp'].get('mcpServers', {})
    if not isinstance(servers, dict):
        raise ValueError('mcpServers must be a JSON object')
    if fragment['mcpServers']:
        data['mcp']['mcpServers'] = servers | fragment['mcpServers']
    skills = data['settings'].get('skills', [])
    if not isinstance(skills, list) or any(not isinstance(s, str) for s in skills):
        raise ValueError('skills must be an array of paths')
    # Stale resource recognition relies on the pi-config derivation name.
    refreshed = [s for s in skills if '-pi-config/skills/' not in s] + fragment['skills']
    if refreshed != skills:
        data['settings']['skills'] = refreshed
    if gateway:
        object_field(data['models'], 'providers')['litellm'] = gateway['providers']['litellm']
        for key in ['defaultProvider', 'defaultModel']:
            data['settings'].setdefault(key, gateway[key])
    return paths, data


def main(mode, directory, fragment_path, gateway_path=None):
    fragment = json.loads(Path(fragment_path).read_text())
    gateway = json.loads(Path(gateway_path).read_text()) if gateway_path else None
    paths, data = prepare(directory, fragment, gateway)
    staged = []
    try:
        for name, path in paths.items():
            # An absent file is an empty object, not a reason to create one.
            if read_object(path) == data[name]:
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix='.pi-', dir=path.parent)
            staged.append((Path(temporary), path))
            with os.fdopen(fd, 'w') as stream:
                json.dump(data[name], stream, indent=2)
                stream.write('\n')
                os.fchmod(stream.fileno(), stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600)
        if mode != '--check':
            for temporary, path in staged:
                temporary.replace(path)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main(*sys.argv[1:])
    except (ValueError, TypeError, KeyError) as error:
        sys.exit(f'Pi: invalid configuration; no files changed: {error}')
    except OSError as error:
        print(f'Pi: warning: cannot merge user configuration: {error}', file=sys.stderr)
        sys.exit(2 if sys.argv[1] == '--check' else 0)
