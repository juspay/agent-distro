"""Inspect real Pi resources without authentication or a model request."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

expected = json.loads(sys.argv[1])
expected_skills = {skill for skills in expected.values() for skill in skills}
agent_dir = Path.home() / '.pi/agent'
agent_dir.mkdir(parents=True, exist_ok=True)
settings = agent_dir / 'settings.json'
mcp = agent_dir / 'mcp.json'
user_server = {'url': 'http://127.0.0.1:9/personal', 'enabled': False}
user_settings = {'theme': 'light', 'defaultProvider': 'personal', 'defaultModel': 'personal-model',
                 'skills': []}
settings.write_text(json.dumps(user_settings))
mcp.write_text(json.dumps({'mcpServers': {'personal': user_server}, 'personalSetting': True}))
env = dict(os.environ, AI_GATEWAY='0', PI_OFFLINE='1')


def run(*args, launcher='pi', overrides=None, success=True):
    result = subprocess.run([launcher, *args], env=env | (overrides or {}),
                            capture_output=True, text=True, timeout=120)
    assert (result.returncode == 0) == success, (result.stdout, result.stderr)
    return result.stdout


def discover(launcher='pi'):
    with tempfile.TemporaryDirectory() as cwd, tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen([launcher, '--no-session', '--mode', 'rpc'], cwd=cwd, env=env,
                                   stdin=subprocess.PIPE, stdout=output, stderr=errors, text=True)
        try:
            process.stdin.write('{"type":"get_commands","id":"skills"}\n')
            process.stdin.flush()
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                data = os.pread(output.fileno(), os.fstat(output.fileno()).st_size, 0)
                messages = [json.loads(line) for line in data.splitlines(keepends=True)
                            if line.endswith(b'\n') and line.strip()]
                responses = [m for m in messages if m.get('command') == 'get_commands']
                if responses:
                    response = responses[0]
                    assert response['success'], response
                    commands = [c for c in response['data']['commands'] if c['source'] == 'skill']
                    assert {c['name'] for c in commands} == {'skill:' + s for s in expected_skills}, commands
                    for plugin, names in expected.items():
                        for name in names:
                            assert any(c['sourceInfo']['path'].endswith(f'/{plugin}/{name}/SKILL.md')
                                       for c in commands), (plugin, name, commands)
                    return commands
                assert process.poll() is None, (process.returncode, data,
                    os.pread(errors.fileno(), os.fstat(errors.fileno()).st_size, 0))
                time.sleep(0.1)
            raise AssertionError(('RPC discovery timed out', messages))
        finally:
            process.terminate()
            process.communicate(timeout=10)


def inventory(launcher='pi'):
    run('--version', launcher=launcher)
    resolved = json.loads(settings.read_text())
    for key, value in user_settings.items():
        if key != 'skills':
            assert resolved[key] == value, resolved
    servers = json.loads(mcp.read_text())
    assert servers['personalSetting'] is True
    assert servers['mcpServers']['personal'] == user_server
    if 'kolu' in expected:
        assert 'kolu' in servers['mcpServers'], servers
    if 'acme.spec-fixture' in expected:
        assert {'placeholders', 'explicit-cwd', 'data-cwd', 'remote'} <= servers['mcpServers'].keys()
        assert 'invalid' not in servers['mcpServers']
        assert servers['mcpServers']['remote'] == {
            'url': 'http://127.0.0.1:9/mcp', 'headers': {'X-Tenant': 'fixture'}}
    return resolved, servers
