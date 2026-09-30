"""Read discovery from OpenCode without authentication or model calls."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

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
    # Upstream exits before large pipe writes drain; a file keeps the full JSON.
    with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as output:
        result = subprocess.run([launcher, '--pure', *args], env=env, text=True,
                                stdout=output, stderr=subprocess.PIPE, timeout=90)
        output.seek(0)
        stdout = output.read()
    assert result.returncode == 0, (stdout, result.stderr)
    return stdout


def config(launcher='opencode'):
    return json.loads(run('debug', 'config', launcher=launcher))


def check_inventory(launcher='opencode'):
    resolved = config(launcher)
    assert resolved['username'] == 'personal-user', resolved
    discovered = json.loads(run('debug', 'skill', launcher=launcher))
    locations = [skill['location'] for skill in discovered]
    for plugin, names in expected.items():
        for name in names:
            assert any(location.endswith(f'/{plugin}/{name}/SKILL.md')
                       for location in locations), (plugin, name, discovered)
    for name, server in resolved.get('mcp', {}).items():
        assert server['type'] in ['local', 'remote'], (name, server)
    assert settings.read_bytes() == preserved
    return resolved
