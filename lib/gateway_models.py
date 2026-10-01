"""Cache bounded gateway model discovery for config-based adapters."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def add_map_model(models, name):
    models[name] = {'name': name}


def add_list_model(models, name):
    if name not in {model['id'] for model in models}:
        models.append({'id': name})


def at_path(value, path):
    for key in path:
        value = value[key]
    return value


def main(base, cache, curl, key_env, shape):
    config = json.loads(Path(base).read_text())
    if isinstance(shape, (str, Path)):
        shape = json.loads(Path(shape).read_text())
    provider = at_path(config, shape['provider'])
    url = at_path(provider, shape['url'])
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
             url + '/models'],
            input=f'header = "{header}"\n', capture_output=True, text=True, check=True)
        models = json.loads(response.stdout)['data']
        if not isinstance(models, list):
            raise ValueError('models data is not a list')
        for model in models:
            name = model['id']
            if not isinstance(name, str) or not name:
                raise ValueError('model id is not a nonempty string')
            add_model = add_list_model if shape['models'] == 'list' else add_map_model
            add_model(provider['models'], name)
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
        print(f'{shape["label"]}: gateway model discovery failed; using {source} from {fallback}', file=sys.stderr)
    print(target if target.is_file() else base)


if __name__ == '__main__':
    main(*sys.argv[1:])
