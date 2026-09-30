"""Agent Plugins stdio environment and placeholder contract."""
import json
import re
import shlex

PLACEHOLDER = re.compile(r'(\$\{PLUGIN_(?:ROOT|DATA)\})')


def word(value):
    """One bash word: the two placeholders expand once, all else is literal."""
    parts = PLACEHOLDER.split(value)
    quoted = [('"$root"' if part == '${PLUGIN_ROOT}' else '"$data"') if i % 2 else shlex.quote(part)
              for i, part in enumerate(parts) if part]
    return ''.join(quoted) or "''"


def launcher(description, name, server, bash, env, data_env=None):
    plugin = description['manifest']['name']
    command = server['command']
    # A bare name is left to PATH lookup at launch; `./` is plugin-relative.
    executable = '"$root"' + shlex.quote(command[1:]) if command.startswith('./') else shlex.quote(command)
    lines = [
        f'#!{bash}',
        f'# {plugin}: MCP server {json.dumps(name)}, launched per Agent Plugins {description["version"]}.',
        'set -euo pipefail',
        f'root=$(cd -- {shlex.quote(description["root"])} && pwd -P)',
        'data=' + ('${' + data_env + ':-' if data_env else '')
        + '${XDG_DATA_HOME:-$HOME/.local/share}/agent-distro/plugins/' + plugin
        + ('}' if data_env else ''),
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

