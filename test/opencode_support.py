"""Read discovery from OpenCode without authentication or model calls."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

expected = json.loads(sys.argv[1])
home = Path.home()
config_dir = home / '.config/opencode'
config_dir.mkdir(parents=True, exist_ok=True)
settings = config_dir / 'opencode.json'
# Upstream adds $schema to schema-less files when loading any configuration.
settings.write_text('{"$schema":"https://opencode.ai/config.json","username":"personal-user"}\n')
preserved = settings.read_bytes()
env = dict(os.environ, AI_GATEWAY='0', OPENCODE_DISABLE_MODELS_FETCH='true')


def run(*args, launcher='opencode'):
    result = subprocess.run([launcher, '--pure', *args], env=env, text=True,
                            capture_output=True, timeout=90)
    assert result.returncode == 0, (result.stdout, result.stderr)
    return result.stdout


def config(launcher='opencode'):
    return json.loads(run('debug', 'config', launcher=launcher))


def skills(launcher='opencode'):
    return json.loads(run('debug', 'skill', launcher=launcher))


def check_inventory(launcher='opencode'):
    resolved = config(launcher)
    assert resolved['username'] == 'personal-user', resolved
    discovered = skills(launcher)
    locations = [skill['location'] for skill in discovered]
    for plugin, names in expected.items():
        for name in names:
            assert any(location.endswith(f'/{plugin}/{name}/SKILL.md')
                       for location in locations), (plugin, name, discovered)
    for name, server in resolved.get('mcp', {}).items():
        assert server['type'] in ['local', 'remote'], (name, server)
    assert settings.read_bytes() == preserved
    return resolved
