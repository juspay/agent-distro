"""OpenCode does not discover custom-provider models; cache a bounded fetch."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main(base, cache, curl, key_env):
    config = json.loads(Path(base).read_text())
    provider = config['provider']['litellm']
    target = Path(cache)
    try:
        response = subprocess.run(
            [curl, '--fail', '--silent', '--show-error', '--connect-timeout', '2',
             '--max-time', '5', '--header', 'Authorization: Bearer ' + os.environ[key_env],
             provider['options']['baseURL'] + '/models'],
            capture_output=True, text=True, check=True)
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
        pass
    print(target if target.is_file() else base)


if __name__ == '__main__':
    main(*sys.argv[1:])
