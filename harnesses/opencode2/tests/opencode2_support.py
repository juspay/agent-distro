"""Read discovery from OpenCode without authentication or model calls."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

expected = json.loads(sys.argv[1])
binary = 'opencode2'
home = Path.home()
config_dir = home / '.config/opencode'
config_dir.mkdir(parents=True, exist_ok=True)
settings = config_dir / 'opencode.json'
# Upstream adds $schema to schema-less files when loading any configuration.
settings.write_text('{"$schema":"https://opencode.ai/config.json","username":"personal-user"}\n')
preserved = settings.read_bytes()
env = dict(os.environ, AI_GATEWAY='0', OPENCODE_DISABLE_MODELS_FETCH='true',
           OPENCODE_DISABLE_AUTOUPDATE='true', OPENCODE_PASSWORD='fixture')


def with_plugins(plugins):
    # AGENT_DISTRO_PLUGINS for one launch only.
    return env if plugins is None else env | {'AGENT_DISTRO_PLUGINS': plugins}


def run(*args, launcher=binary, plugins=None):
    # Upstream exits before large pipe writes drain; a file keeps the full JSON.
    with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as output:
        result = subprocess.run([launcher, *args], env=with_plugins(plugins), text=True,
                                stdout=output, stderr=subprocess.PIPE, timeout=90)
        output.seek(0)
        stdout = output.read()
    assert result.returncode == 0, (stdout, result.stderr)
    return stdout


def config(launcher=binary, plugins=None):
    # The personal fixture and generated document have disjoint settings.
    return {key: value for entry in api('config', launcher, plugins) if entry['type'] == 'document'
            for key, value in entry['info'].items()}


def api(resource, launcher=binary, plugins=None):
    # The server reads the config; `api` only talks to it.
    with subprocess.Popen([launcher, 'serve', '--stdio', '--port', '0'], env=with_plugins(plugins),
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as server:
        try:
            url = json.loads(server.stdout.readline())['url']
            def get(resource):
                return json.loads(run('api', '--server', url, 'GET', '/api/' + resource,
                                      '--header', 'x-opencode-directory:' + str(home), launcher=launcher))
            # Cold locations activate plugins asynchronously; this endpoint waits for activation.
            get('integration')
            for _ in range(60):
                result = get(resource)
                if resource != 'mcp' or all(s['status']['status'] != 'pending' for s in result['data']):
                    return result
                time.sleep(0.5)
            raise AssertionError(result)
        finally:
            server.stdin.close()
            server.wait(timeout=90)


def servers(resolved):
    mcp = resolved.get('mcp', {})
    return mcp.get('servers', {})


def skill_paths(resolved):
    return resolved['skills']


def check_inventory(launcher=binary):
    resolved = config(launcher)
    assert resolved['username'] == 'personal-user', resolved
    discovered = api('skill', launcher)['data']
    locations = [skill['path'] for skill in discovered]
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


def skill_locations(plugins=None):
    return [skill['path'] for skill in api('skill', plugins=plugins)['data']]
