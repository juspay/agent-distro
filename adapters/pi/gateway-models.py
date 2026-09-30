"""Add the gateway's served models to the user's models.json, ours only.

Pi reads models.json statically from the agent directory; the launcher is the
only place a gateway's live `/v1/models` list can reach it. The `litellm`
provider is ours: replaced wholesale on every launch (store paths change),
other providers and top-level keys untouched. A dead gateway falls back to the
cached list, then to the two profile aliases, warning either way.

Usage: gateway-models.py AGENT_DIR CACHE KEY_ENV CURL BASE_MODELS_JSON
"""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

from gateway_models import fetch_ids


def load_user(path):
    """The user's current models.json, or {} when absent. Invalid JSON
    aborts the launch without writing, like merge-mcp.py."""
    if not path.exists():
        return {}
    try:
        merged = json.loads(path.read_text())
    except (ValueError, UnicodeDecodeError) as error:
        sys.exit(f'pi: cannot update models.json: {path} is not valid JSON: {error}')
    if not isinstance(merged, dict):
        sys.exit(f'pi: cannot update models.json: {path} must be an object')
    return merged


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix='.models-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(agent_dir, cache, key_env, curl, base):
    agent_dir = Path(agent_dir)
    cache = Path(cache)
    gateway_cfg = json.loads(Path(base).read_text())
    provider = gateway_cfg['providers']['litellm']
    aliases = [model['id'] for model in provider['models']]
    merged = load_user(agent_dir / 'models.json')
    providers = merged.setdefault('providers', {})
    if not isinstance(providers, dict):
        sys.exit(f'pi: cannot update models.json: "providers" must be an object')
    # The cache and the user file always carry at least the aliases: a dead
    # gateway must not take the gateway's models away from a launch.
    selected = None
    try:
        served = fetch_ids(curl, provider['baseUrl'], key_env)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError,
            subprocess.SubprocessError):
        if cache.is_file():
            source = 'cached model list'
            fallback = cache
            selected = json.loads(cache.read_text())['providers']['litellm']['models']
        else:
            source = 'two profile aliases'
            fallback = Path(base)
            selected = [{'id': alias} for alias in aliases]
        print(f'Pi: gateway model discovery failed; using {source} from {fallback}', file=sys.stderr)

    else:
        seen = set(aliases)
        models = [{'id': alias} for alias in aliases]
        for name in served:
            if name not in seen:
                seen.add(name)
                models.append({'id': name})
        selected = models
        # A fresh fetch replaces the cache before it is ever read back.
        save(cache, {'providers': {'litellm': dict(provider, models=models)}})
    providers['litellm'] = dict(provider, models=selected)
    save(agent_dir / 'models.json', merged)


if __name__ == '__main__':
    main(*sys.argv[1:])