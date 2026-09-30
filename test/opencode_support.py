"""Read discovery from OpenCode without authentication or model calls."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

expected = json.loads(sys.argv[1])
binary = os.environ.get('OPENCODE_TEST_BINARY', 'opencode')
v2 = binary == 'opencode2'
home = Path.home()
config_dir = home / '.config/opencode'
config_dir.mkdir(parents=True, exist_ok=True)
settings = config_dir / 'opencode.json'
# Upstream adds $schema to schema-less files when loading any configuration.
settings.write_text('{"$schema":"https://opencode.ai/config.json","username":"personal-user"}\n')
preserved = settings.read_bytes()
env = dict(os.environ, AI_GATEWAY='0', OPENCODE_DISABLE_MODELS_FETCH='true',
           OPENCODE_DISABLE_AUTOUPDATE='true')


def run(*args, launcher=binary):
    # Upstream exits before large pipe writes drain; a file keeps the full JSON.
    with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as output:
        result = subprocess.run([launcher, *([] if v2 else ['--pure']), *args], env=env, text=True,
                                stdout=output, stderr=subprocess.PIPE, timeout=90)
        output.seek(0)
        stdout = output.read()
    assert result.returncode == 0, (stdout, result.stderr)
    return stdout


def config(launcher=binary):
    if not v2:
        return json.loads(run('debug', 'config', launcher=launcher))
    entries = api('config', launcher)
    resolved = {}
    for entry in entries:
        if entry['type'] == 'document':
            merge(resolved, entry['info'])
    return resolved


def merge(target, source):
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            merge(target[key], value)
        elif isinstance(value, list) and isinstance(target.get(key), list):
            target[key].extend(value)
        else:
            target[key] = value


def api(resource, launcher=binary):
    # These endpoints inspect the private server; debug/mcp CLI commands do not.
    return json.loads(run('api', '--standalone', 'GET', '/api/' + resource,
                          '--header', 'x-opencode-directory: ' + str(home),
                          launcher=launcher))


def servers(resolved):
    mcp = resolved.get('mcp', {})
    return mcp.get('servers', {}) if v2 else mcp


def skill_paths(resolved):
    return resolved['skills'] if v2 else resolved['skills']['paths']


def check_inventory(launcher=binary):
    resolved = config(launcher)
    assert resolved['username'] == 'personal-user', resolved
    discovered = api('skill', launcher)['data'] if v2 else json.loads(run('debug', 'skill', launcher=launcher))
    locations = [skill['path' if v2 else 'location'] for skill in discovered]
    for plugin, names in expected.items():
        for name in names:
            assert any(location.endswith(f'/{plugin}/{name}/SKILL.md')
                       for location in locations), (plugin, name, discovered)
    for name, server in servers(resolved).items():
        assert server['type'] in ['local', 'remote'], (name, server)
    assert settings.read_bytes() == preserved
    return resolved
