"""Translate validated plugins into Pi's inputs, once, at build time.

Pi reads MCP servers only from `~/.pi/agent/mcp.json` — there is no CLI flag
or package manifest key — so this writes the launcher scripts and a JSON
fragment of our `mcpServers` entries. merge-mcp.py (the launcher) fuses the
fragment into the user's file at launch: Pi has no per-session config, so the
store paths the fragment names must be refreshed on every launch anyway, and
writing only our entries keeps the user's own servers intact.

Usage: write-config.py OUT BASH ENV [GATEWAY_JSON] DESCRIPTION...
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from mcp_launcher import launcher
from skills import materialise


def main(out, bash, env, gateway_path, *descriptions):
    root = Path(out)
    (root / 'bin').mkdir(parents=True)
    owners = {}
    servers = {}
    skills = []
    for path in descriptions:
        description = json.loads(Path(path).read_text())
        plugin = description['manifest']['name']
        if description['skills']:
            skills.append(materialise(root, description))
        for index, (name, server) in enumerate(description['mcpServers'].items()):
            if name in owners:
                raise SystemExit(f'Pi: MCP server {json.dumps(name)} is declared by both '
                                 f'plugins {json.dumps(owners[name])} and {json.dumps(plugin)}')
            owners[name] = plugin
            if server['type'] != 'stdio':
                # SSE is not supported by Pi; report and skip, like Claude's "=" skip.
                if server['type'] == 'sse':
                    print(f'{description["root"]}: mcp.json: server {json.dumps(name)} skipped, '
                          'Pi does not support the SSE transport', file=sys.stderr)
                else:
                    servers[name] = {'url': server['url'], 'headers': server['headers']}
                continue
            if '=' in server['command'] or '=' in description['root']:
                print(f'{description["root"]}: mcp.json: server {json.dumps(name)} skipped, '
                      'Pi adapter cannot launch a command containing "="', file=sys.stderr)
                continue
            script = root / 'bin' / f'{plugin}-{index}-{re.sub(r"[^A-Za-z0-9._-]", "_", name)}'
            script.write_text(launcher(description, name, server, bash, env, 'PI_MCP_DATA'))
            script.chmod(0o700)
            servers[name] = {'command': str(script)}
    (root / 'mcp.json').write_text(json.dumps({'mcpServers': servers}, indent=2))
    gateway = json.loads(Path(gateway_path).read_text())
    if gateway is not None:
        (root / 'models.json').write_text(json.dumps({
            'providers': {
                'litellm': {
                    # `$NAME` reads an environment variable into the value.
                    'baseUrl': gateway['url'].rstrip('/') + '/v1',
                    'api': 'openai-completions',
                    'apiKey': '$' + gateway['keyEnv'],
                    'models': [{'id': gateway['models']['large']},
                               {'id': gateway['models']['small']}],
                },
            },
        }, indent=2))
        (root / 'settings.json').write_text(json.dumps({
            'defaultProvider': 'litellm',
            'defaultModel': gateway['models']['large'],
        }, indent=2))


if __name__ == '__main__':
    main(*sys.argv[1:])