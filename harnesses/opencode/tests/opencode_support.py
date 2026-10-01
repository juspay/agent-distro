"""Read discovery from OpenCode without authentication or model calls."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

expected = json.loads(sys.argv[1])
binary = 'opencode'
home = Path.home()
config_dir = home / '.config/opencode'
config_dir.mkdir(parents=True, exist_ok=True)
settings = config_dir / 'opencode.json'
# Upstream adds $schema to schema-less files when loading any configuration.
settings.write_text('{"$schema":"https://opencode.ai/config.json","username":"personal-user"}\n')
preserved = settings.read_bytes()
env = dict(os.environ, AI_GATEWAY='0', OPENCODE_DISABLE_MODELS_FETCH='true',
           OPENCODE_DISABLE_AUTOUPDATE='true', OPENCODE_PASSWORD='fixture')


def run(*args, launcher=binary):
    # Upstream exits before large pipe writes drain; a file keeps the full JSON.
    with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as output:
        result = subprocess.run([launcher, '--pure', *args], env=env, text=True,
                                stdout=output, stderr=subprocess.PIPE, timeout=90)
        output.seek(0)
        stdout = output.read()
    assert result.returncode == 0, (stdout, result.stderr)
    return stdout


def config(launcher=binary):
    return json.loads(run('debug', 'config', launcher=launcher))


def servers(resolved):
    mcp = resolved.get('mcp', {})
    return mcp


def skill_paths(resolved):
    return resolved['skills']['paths']


def check_inventory(launcher=binary):
    resolved = config(launcher)
    assert resolved['username'] == 'personal-user', resolved
    discovered = json.loads(run('debug', 'skill', launcher=launcher))
    locations = [skill['location'] for skill in discovered]
    for plugin, names in expected.items():
        for name in names:
            assert any(location.endswith(f'/{plugin}/{name}/SKILL.md')
                       for location in locations), (plugin, name, discovered)
    for name, server in servers(resolved).items():
        assert server['type'] in ['local', 'remote'], (name, server)
    assert settings.read_bytes() == preserved
    return resolved
