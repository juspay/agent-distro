"""A bounded, cached fetch of a gateway's /v1/models list.

Adapters differ in where the models land (a session-config cache, the user's
models.json) and in what stands in when the gateway is unreachable; the fetch
itself and the atomic cache write are the same everywhere.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile


def fetch_ids(curl, base_url, key_env):
    """One gateway call. Returns the served ids; raises on any failure."""
    header = 'Authorization: Bearer ' + os.environ[key_env]
    if '\r' in header or '\n' in header:
        raise ValueError('invalid gateway key')
    # curl's config quoting keeps credentials off the process command line.
    header = header.replace('\\', '\\\\').replace('"', '\\"')
    response = subprocess.run(
        [curl, '--fail', '--silent', '--show-error', '--connect-timeout', '2',
         '--max-time', '5', '--config', '-', base_url + '/models'],
        input=f'header = "{header}"\n', capture_output=True, text=True, check=True)
    ids = []
    for model in json.loads(response.stdout)['data']:
        if not isinstance(model, dict) or 'id' not in model:
            raise ValueError('model entry lacks an "id"')
        name = model['id']
        if not isinstance(name, str) or not name:
            raise ValueError('model id is not a nonempty string')
        ids.append(name)
    return ids


def write_atomic(target, data):
    """Replace target with data, atomically; concurrent launches never see a
    partially written file."""
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, delete=False) as output:
        temporary = Path(output.name)
        json.dump(data, output, indent=2)
    try:
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)