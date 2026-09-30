"""OpenCode does not discover custom-provider models; cache a bounded fetch."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main(base, cache, curl, key_env, schema="v1"):
    config = json.loads(Path(base).read_text())
    provider = config['providers' if schema == 'v2' else 'provider']['litellm']
    settings = provider['settings' if schema == 'v2' else 'options']
    target = Path(cache)
    try:
        header = 'Authorization: Bearer ' + os.environ[key_env]
        if '\r' in header or '\n' in header:
            raise ValueError('invalid gateway key')
        # curl's config quoting keeps credentials off the process command line.
        header = header.replace('\\', '\\\\').replace('"', '\\"')
        response = subprocess.run(
            [curl, '--fail', '--silent', '--show-error', '--connect-timeout', '2',
             '--max-time', '5', '--config', '-',
             settings['baseURL'] + '/models'],
            input=f'header = "{header}"\n', capture_output=True, text=True, check=True)
        models = json.loads(response.stdout)['data']
        if not isinstance(models, list):
            raise ValueError('models data is not a list')
        for model in models:
            name = model['id']
            if not isinstance(name, str) or not name:
                raise ValueError('model id is not a nonempty string')
            provider['models'][name] = {'name': name}
        target.parent.mkdir(parents=True, exist_ok=True)
        # Concurrent launches must never see a partially written config.
        with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            json.dump(config, output, indent=2)
        try:
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        fallback = target if target.is_file() else Path(base)
        source = 'cached model list' if fallback == target else 'two profile aliases'
        print(f'OpenCode: gateway model discovery failed; using {source} from {fallback}', file=sys.stderr)
    print(target if target.is_file() else base)


if __name__ == '__main__':
    main(*sys.argv[1:])
