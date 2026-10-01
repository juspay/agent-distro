"""Translate plugins to Pi resources without injecting global CLI options."""
import json
from pathlib import Path
import sys

from plugin_resources import copy_skills, write_launcher


def main(out, bash, env, gateway_path, *descriptions):
    root = Path(out)
    root.mkdir(parents=True)
    skills, servers, owners = [], {}, {}
    for path in descriptions:
        description = json.loads(Path(path).read_text())
        plugin = description['manifest']['name']
        skill_path = copy_skills(description, root)
        if skill_path:
            skills.append(skill_path)
        for index, (name, server) in enumerate(description['mcpServers'].items()):
            if name in owners:
                raise SystemExit(f'Pi: MCP server {name!r} is declared by both '
                                 f'plugins {owners[name]!r} and {plugin!r}')
            owners[name] = plugin
            reason = None
            if server['type'] == 'sse':
                reason = 'Pi does not support SSE'
            elif server['type'] == 'stdio':
                if '=' in server['command'] or '=' in description['root']:
                    reason = 'Pi adapter cannot launch a command containing "="'
                else:
                    servers[name] = {'command': write_launcher(
                        description, name, server, root, index, bash, env)}
            else:
                servers[name] = {'url': server['url'], 'headers': server['headers']}
            if reason:
                print(f'{description["root"]}: mcp.json: server {json.dumps(name)} skipped, '
                      f'{reason}', file=sys.stderr)
    (root / 'config.json').write_text(json.dumps({'skills': skills, 'mcpServers': servers}, indent=2))
    gateway = json.loads(Path(gateway_path).read_text())
    if gateway is not None:
        config = {'providers': {'litellm': {
            'baseUrl': gateway['url'].rstrip('/') + '/v1',
            'api': 'openai-completions', 'apiKey': '$' + gateway['keyEnv'],
            'models': [{'id': model} for model in dict.fromkeys(gateway['models'].values())],
        }}, 'defaultProvider': 'litellm', 'defaultModel': gateway['models']['large']}
        (root / 'gateway.json').write_text(json.dumps(config, indent=2))


if __name__ == '__main__':
    main(*sys.argv[1:])
