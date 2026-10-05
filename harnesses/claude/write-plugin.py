"""Translate one plugin description into a Claude Code plugin directory.

Usage: write-plugin.py OUT ARGS_JSON

Each part reads the validated description, never the plugin's own JSON, so a
Claude Code format change touches this file and a spec change none. Skills are
only the discovered ones, with only their in-root files, materialized: Claude
rejects component symlinks outside its root.

Claude Code runs a plugin's stdio server in its own launch directory and
applies its own variable expansion, neither of which is the Agent Plugins
contract. So each stdio server gets a launcher script that sets up the spec's
environment, working directory and placeholders itself, and Claude Code is
handed only that script. Remote servers cannot be wrapped and are mapped to
Claude Code's transport names.
"""
import json
import os
from pathlib import Path
import re
import sys

from mcp_launcher import launcher
from plugin_resources import copy_skills

MANIFEST_FIELDS = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']
TRANSPORTS = {'streamable-http': 'http', 'sse': 'sse'}


def main(out, args_path):
    args = json.loads(Path(args_path).read_text())
    description = json.loads(Path(args['description']).read_text())
    out = Path(out)
    (out / '.claude-plugin').mkdir(parents=True)
    manifest = {key: description['manifest'][key] for key in MANIFEST_FIELDS
                if description['manifest'].get(key) is not None}
    (out / '.claude-plugin/plugin.json').write_text(json.dumps(manifest, indent=2))
    (out / 'skills').mkdir()
    copy_skills(description, out / 'skills')
    servers = {}
    for index, (name, server) in enumerate(description['mcpServers'].items()):
        if server['type'] in TRANSPORTS:
            servers[name] = {'type': TRANSPORTS[server['type']], 'url': server['url']}
            if server['headers']:
                servers[name]['headers'] = server['headers']
            continue
        # `env` reads its first argument without "=" as the command.
        if '=' in server['command'] or '=' in description['root']:
            print(f'{description["root"]}: mcp.json: server {json.dumps(name)} skipped, '
                  'Claude Code adapter cannot launch a command containing "="', file=sys.stderr)
            continue
        script = out / 'mcp-launchers' / f'{index}-{re.sub(r"[^A-Za-z0-9._-]", "_", name)}'
        script.parent.mkdir(exist_ok=True)
        # Owner bits suffice: Nix canonicalizes store files to 0555/0444 on
        # registration, so the launcher is executable by every user.
        with os.fdopen(os.open(script, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700), 'w') as f:
            f.write(launcher(description, name, server, args['bash'], args['env'], 'CLAUDE_PLUGIN_DATA'))
        servers[name] = {'type': 'stdio', 'command': str(script)}
    if servers:
        (out / '.mcp.json').write_text(json.dumps({'mcpServers': servers}, indent=2))


if __name__ == '__main__':
    main(*sys.argv[1:])
