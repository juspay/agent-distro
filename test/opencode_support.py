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
           OPENCODE_DISABLE_AUTOUPDATE='true', OPENCODE_PASSWORD='fixture')


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
    # The personal fixture and generated document have disjoint settings.
    return {key: value for entry in api('config', launcher) if entry['type'] == 'document'
            for key, value in entry['info'].items()}


def api(resource, launcher=binary):
    with subprocess.Popen([launcher, 'serve', '--stdio', '--port', '0'], env=env,
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
