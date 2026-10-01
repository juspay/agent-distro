"""Convert a plugin description's MCP servers into Claude Code's .mcp.json.

Usage: write-mcp.py DESCRIPTION BASH ENV OUT

Claude Code runs a plugin's stdio server in its own launch directory and
applies its own variable expansion, neither of which is the Agent Plugins
contract. So each stdio server gets a launcher script that sets up the spec's
environment, working directory and placeholders itself, and Claude Code is
handed only that script. Remote servers cannot be wrapped and are mapped to
Claude Code's transport names.
"""
import json
import os
import re
import sys

from mcp_launcher import launcher

TRANSPORTS = {'streamable-http': 'http', 'sse': 'sse'}


def main(description_path, bash, env, out):
    with open(description_path) as f:
        description = json.load(f)
    os.makedirs(os.path.join(out, 'bin'))
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
        script = os.path.join(out, 'bin', f'{index}-{re.sub(r"[^A-Za-z0-9._-]", "_", name)}')
        # Owner bits suffice: Nix canonicalizes store files to 0555/0444 on
        # registration, so the launcher is executable by every user.
        with os.fdopen(os.open(script, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700), 'w') as f:
            f.write(launcher(description, name, server, bash, env, 'CLAUDE_PLUGIN_DATA'))
        servers[name] = {'type': 'stdio', 'command': script}
    if servers:
        with open(os.path.join(out, 'mcp.json'), 'w') as f:
            json.dump({'mcpServers': servers}, f, indent=2)


if __name__ == '__main__':
    main(*sys.argv[1:])
