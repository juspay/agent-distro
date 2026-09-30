"""Translate validated plugins once; OpenCode merges this file at launch."""
import json
from pathlib import Path
import re
import subprocess
import sys

from mcp_launcher import launcher


def main(schema, out, bash, env, gateway_path, *descriptions):
    if schema not in ('v1', 'v2'):
        raise ValueError(f'Unknown OpenCode schema: {schema}')
    owners = {}
    root = Path(out)
    (root / 'bin').mkdir(parents=True)
    skills_paths, servers = [], {}
    config = {'$schema': 'https://opencode.ai/config.json',
              'skills': skills_paths if schema == 'v2' else {'paths': skills_paths},
              'mcp': {'servers': servers} if schema == 'v2' else servers}
    for path in descriptions:
        description = json.loads(Path(path).read_text())
        plugin = description['manifest']['name']
        skills = root / 'skills' / plugin
        if description['skills']:
            for name, files in description['skills'].items():
                for file in files:
                    target = skills / name / file
                    target.parent.mkdir(parents=True, exist_ok=True)
                    # Only reader-approved files, dereferenced as in Claude's adapter.
                    subprocess.run(['cp', '-L', '--', Path(description['root']) / 'skills' / name / file,
                                    target], check=True)
            skills_paths.append(str(skills))
        for index, (name, server) in enumerate(description['mcpServers'].items()):
            if name in owners:
                raise SystemExit(f'OpenCode: MCP server {json.dumps(name)} is declared by both '
                                 f'plugins {json.dumps(owners[name])} and {json.dumps(plugin)}')
            owners[name] = plugin
            if server['type'] != 'stdio':
                servers[name] = {'type': 'remote', 'url': server['url'],
                                      'headers': server['headers']}
                continue
            if '=' in server['command'] or '=' in description['root']:
                print(f'{description["root"]}: mcp.json: server {json.dumps(name)} skipped, '
                      'OpenCode adapter cannot launch a command containing "="', file=sys.stderr)
                continue
            script = root / 'bin' / f'{plugin}-{index}-{re.sub(r"[^A-Za-z0-9._-]", "_", name)}'
            script.write_text(launcher(description, name, server, bash, env))
            script.chmod(0o700)
            servers[name] = {'type': 'local', 'command': [str(script)]}
    (root / 'opencode.json').write_text(json.dumps(config, indent=2))
    gateway = json.loads(Path(gateway_path).read_text())
    if gateway is not None:
        provider = {
            'name': 'LiteLLM',
            'models': {model: {'name': model} for model in gateway['models'].values()},
        }
        url = gateway['url'].rstrip('/') + '/v1'
        if schema == 'v2':
            provider.update(env=[gateway['keyEnv']], package='@opencode/ai/providers/openai-compatible',
                            settings={'baseURL': url})
            config['providers'] = {'litellm': provider}
        else:
            provider.update(npm='@ai-sdk/openai-compatible',
                            options={'baseURL': url, 'apiKey': '{env:' + gateway['keyEnv'] + '}'})
            config['provider'] = {'litellm': provider}
            config['small_model'] = 'litellm/' + gateway['models']['small']
        config['model'] = 'litellm/' + gateway['models']['large']
        (root / 'gateway.json').write_text(json.dumps(config, indent=2))


if __name__ == '__main__':
    main(*sys.argv[1:])
