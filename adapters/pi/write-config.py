"""Translate validated plugins into Pi's inputs, once, at build time.

Pi reads its state statically: MCP servers from `~/.pi/agent/mcp.json`,
skills and defaults from `settings.json`, models from `models.json`. There is
no CLI flag or package manifest key for any of them, so this writes the launcher
scripts and one JSON fragment per user file; pi-state.py (the launcher) fuses
the fragments into the user's files at launch, keeping their own entries
intact.

Usage: write-config.py OUT BASH ENV [GATEWAY_JSON] DESCRIPTION...
"""
import json
import re
import sys
from pathlib import Path

from mcp_launcher import launcher
from skills import materialise


def main(out, bash, env, gateway_path, *descriptions):
    root = Path(out)
    (root / 'bin').mkdir(parents=True)
    owners = {}
    servers = {}
    skill_dirs = []
    for path in descriptions:
        description = json.loads(Path(path).read_text())
        plugin = description['manifest']['name']
        if description['skills']:
            # The reader-approved files only, under this config's store path:
            # pi-state.py recognises our skill entries by that path segment.
            skill_dirs.append(materialise(root, description))
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
            script.write_text(launcher(description, name, server, bash, env))
            script.chmod(0o700)
            servers[name] = {'command': str(script)}
    (root / 'mcp.json').write_text(json.dumps({'mcpServers': servers}, indent=2))
    # Skills are not gateway-dependent: Pi loads the `skills` array from user
    # settings on every launch, so the entries (this config's materialised
    # dirs) are fused in unconditionally rather than from a --skill flag that
    # broke Pi's other subcommands.
    (root / 'settings.json').write_text(json.dumps({
        'skills': [str(root / 'skills' / Path(path).name) for path in skill_dirs],
        'defaults': gateway_defaults(gateway_path),
    }, indent=2))
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


def gateway_defaults(gateway_path):
    gateway = json.loads(Path(gateway_path).read_text())
    if gateway is None:
        return {}
    return {'defaultProvider': 'litellm', 'defaultModel': gateway['models']['large']}


if __name__ == '__main__':
    main(*sys.argv[1:])
