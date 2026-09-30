"""Read Pi discovery without authentication or model calls.

Pi's subcommands are unreachable once a global option precedes them (a
known CLI quirk: `pi --skill X mcp list --json` parses `--json` as a main
option), so MCP inspection runs without the launcher's `--skill` flags — MCP
servers come from the merged `~/.pi/agent/mcp.json`, not from `--skill`.
Skills, which only `--skill` provides, are read over RPC (`get_commands`),
which lists them without starting a model session.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

expected = json.loads(sys.argv[1])
home = Path.home()
agent_dir = home / '.pi/agent'
agent_dir.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, AI_GATEWAY='0', PI_SKIP_VERSION_CHECK='1')
user_mcp = agent_dir / 'mcp.json'
user_settings = agent_dir / 'settings.json'


def run(*args, launcher='pi', check=True, timeout=90):
    result = subprocess.run([launcher, *args], env=env, text=True,
                            capture_output=True, timeout=timeout)
    if check:
        assert result.returncode == 0, (result.stdout, result.stderr)
    return result


def rpc(launcher='pi'):
    """Skills listed by Pi itself, over RPC; no model or auth involved."""
    with subprocess.Popen([launcher, '--no-session', '--mode', 'rpc'], env=env,
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True, cwd=home) as process:
        process.stdin.write('{"type": "get_commands"}\n')
        process.stdin.flush()
        commands = {}
        for line in process.stdout:
            message = json.loads(line)
            if message.get('type') == 'response' and message.get('command') == 'get_commands':
                for command in message['data']['commands']:
                    commands[command['name']] = command
                break
        process.stdin.close()
        process.wait(timeout=60)
    return commands


def skill_names(launcher='pi'):
    commands = rpc(launcher)
    return {name.removeprefix('skill:') for name, command in commands.items()
            if command['source'] == 'skill'}


def assert_skills(launcher='pi'):
    """The bundled skills are exactly the reader's expected ones."""
    discovered = skill_names(launcher)
    expected_names = {name for names in expected.values() for name in names}
    assert discovered == expected_names, (discovered, expected_names)
    return discovered


def assert_preserved():
    # The adapter never rewrites the user's own entries or settings.
    assert 'user-server' in json.loads(user_mcp.read_text())['mcpServers']
    assert json.loads(user_settings.read_text())['personal'] == 'keep'