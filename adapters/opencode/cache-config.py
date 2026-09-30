"""OpenCode does not discover custom-provider models; cache a bounded fetch."""
import json
from pathlib import Path
import subprocess
import sys

from gateway_models import fetch_ids, write_atomic


def main(base, cache, curl, key_env, schema="v1"):
    config = json.loads(Path(base).read_text())
    provider = config['providers' if schema == 'v2' else 'provider']['litellm']
    settings = provider['settings' if schema == 'v2' else 'options']
    target = Path(cache)
    try:
        for name in fetch_ids(curl, settings['baseURL'], key_env):
            provider['models'][name] = {'name': name}
        write_atomic(target, config)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError,
            subprocess.SubprocessError):
        fallback = target if target.is_file() else Path(base)
        source = 'cached model list' if fallback == target else 'two profile aliases'
        print(f'OpenCode: gateway model discovery failed; using {source} from {fallback}', file=sys.stderr)
    print(target if target.is_file() else base)


if __name__ == '__main__':
    main(*sys.argv[1:])
