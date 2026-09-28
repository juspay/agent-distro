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
import shlex
import sys

TRANSPORTS = {'streamable-http': 'http', 'sse': 'sse'}
PLACEHOLDER = re.compile(r'(\$\{PLUGIN_(?:ROOT|DATA)\})')


def word(value):
    """One bash word: the two placeholders expand once, all else is literal."""
    parts = PLACEHOLDER.split(value)
    quoted = [('"$root"' if part == '${PLUGIN_ROOT}' else '"$data"') if i % 2 else shlex.quote(part)
              for i, part in enumerate(parts) if part]
    return ''.join(quoted) or "''"


def launcher(description, name, server, bash, env):
    plugin = description['manifest']['name']
    command = server['command']
    # A bare name is left to PATH lookup at launch; `./` is plugin-relative.
    executable = '"$root"' + shlex.quote(command[1:]) if command.startswith('./') else shlex.quote(command)
    lines = [
        f'#!{bash}',
        f'# {plugin}: MCP server {json.dumps(name)}, launched per Agent Plugins {description["version"]}.',
        'set -euo pipefail',
        f'root=$(cd -- {shlex.quote(description["root"])} && pwd -P)',
        # Claude Code creates and keeps a per-plugin data directory; outside it,
        # fall back to one of our own.
        'data=${CLAUDE_PLUGIN_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-distro/plugins/'
        + plugin + '}',
        'mkdir -p -- "$data"',
        'data=$(cd -- "$data" && pwd -P)',
    ]
    if 'cwd' in server:
        cwd = server['cwd']
        target = '"$root"/' + word(cwd[2:]) if cwd.startswith('./') else word(cwd)
        base = '"$root"' if server['cwdBase'] == 'root' else '"$data"'
        lines += [
            f'cd -- {target}',
            f'case "$(pwd -P)/" in {base}/*) ;; *)',
            f'  echo {shlex.quote(f"{plugin}: MCP server {name}: cwd escapes its root")} >&2; exit 1 ;;',
            'esac',
        ]
    else:
        lines.append('cd -- "$root"')
    # Configured env overlays the inherited environment, then PLUGIN_ROOT and
    # PLUGIN_DATA are set last (§9.1). `env` accepts names bash cannot export.
    assignments = [shlex.quote(key + '=') + word(value) for key, value in server['env'].items()]
    assignments += ['"PLUGIN_ROOT=$root"', '"PLUGIN_DATA=$data"']
    lines.append(' '.join(['exec', shlex.quote(env), '--', *assignments, executable,
                           *(word(arg) for arg in server['args'])]))
    return '\n'.join(lines) + '\n'


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
            f.write(launcher(description, name, server, bash, env))
        servers[name] = {'type': 'stdio', 'command': script}
    if servers:
        with open(os.path.join(out, 'mcp.json'), 'w') as f:
            json.dump({'mcpServers': servers}, f, indent=2)


if __name__ == '__main__':
    main(*sys.argv[1:])
