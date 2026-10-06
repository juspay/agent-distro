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


def run(*args, launcher=binary, plugins=None):
    # `plugins` is AGENT_DISTRO_PLUGINS for this launch only.
    extra = {} if plugins is None else {'AGENT_DISTRO_PLUGINS': plugins}
    # Upstream exits before large pipe writes drain; a file keeps the full JSON.
    with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as output:
        result = subprocess.run([launcher, '--pure', *args], env=env | extra, text=True,
                                stdout=output, stderr=subprocess.PIPE, timeout=90)
        output.seek(0)
        stdout = output.read()
    assert result.returncode == 0, (stdout, result.stderr)
    return stdout


def config(launcher=binary, plugins=None):
    return json.loads(run('debug', 'config', launcher=launcher, plugins=plugins))


def skill_locations(launcher=binary, plugins=None):
    return [skill['location'] for skill in json.loads(run('debug', 'skill', launcher=launcher, plugins=plugins))]


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


def checkout(name, skill):
    """A plugin working copy outside the store, as a user edits one."""
    root = home / 'checkouts' / name
    (root / 'skills' / skill).mkdir(parents=True)
    (root / 'plugin.json').write_text(json.dumps({
        '$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'name': name}))
    (root / 'skills' / skill / 'SKILL.md').write_text(f'---\nname: {skill}\ndescription: {skill}\n---\n')
    return str(root)
