import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tomllib

expected = json.loads(sys.argv[1])
marketplace = sys.argv[2]
home = Path.home()
codex_home = home / 'relocated-codex'
codex_home.mkdir()
env = dict(os.environ, CODEX_HOME=str(codex_home), AI_GATEWAY='0')
config = codex_home / 'config.toml'
config.write_text('# personal settings\nmodel = "my-model"\n[mcp_servers.personal]\ncommand = "true"\n')
auth = codex_home / 'auth.json'
auth.write_text('{"OPENAI_API_KEY":"test-api-key"}\n')
session = codex_home / 'sessions' / 'keep.jsonl'
session.parent.mkdir()
session.write_text('session sentinel\n')
skill = codex_home / 'skills' / 'personal' / 'SKILL.md'
skill.parent.mkdir(parents=True)
skill.write_text('---\nname: personal\ndescription: Personal skill\n---\n')


def run(*args, launcher='codex', **kwargs):
    return subprocess.run([launcher, *args], env=env, text=True,
                          capture_output=True, timeout=60, **kwargs)


def upstream(*args):
    return subprocess.run(['codex-upstream', *args], env=env, text=True,
                          capture_output=True, timeout=60, check=True)


def marketplace_root():
    marketplaces = json.loads(upstream('plugin', 'marketplace', 'list', '--json').stdout)
    return next(m['root'] for m in marketplaces['marketplaces'] if m['name'] == marketplace)


def installed_plugins():
    installed = json.loads(upstream('plugin', 'list', '--json').stdout)['installed']
    return {p['pluginId']: p for p in installed}


def loaded_skills(launcher='codex'):
    # No thread or model request: initialize, then ask the real app server for
    # its effective skills. A timeout also catches protocol changes in updates.
    process = subprocess.Popen([launcher, 'app-server'], env=env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True)
    def request(request_id, method, params):
        process.stdin.write(json.dumps({'id': request_id, 'method': method, 'params': params}) + '\n')
        process.stdin.flush()
        for line in process.stdout:
            response = json.loads(line)
            if response.get('id') == request_id:
                assert 'error' not in response, response
                return response['result']
        raise AssertionError('Codex exited without answering ' + method)

    def timeout(*_):
        raise TimeoutError('Codex skill discovery timed out')

    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(60)
    try:
        request(1, 'initialize', {'clientInfo': {'name': 'ai-test', 'version': '1'},
                                  'capabilities': {'experimentalApi': True}})
        process.stdin.write('{"method":"initialized"}\n')
        process.stdin.flush()
        result = request(2, 'skills/list', {'cwds': [str(home)], 'forceReload': True})
        entry = result['data'][0]
        assert not entry['errors'], entry['errors']
        return {skill['name']: skill for skill in entry['skills'] if skill['enabled']}
    finally:
        signal.alarm(0)
        process.terminate()
        process.wait(timeout=10)



def assert_skills(launcher='codex'):
    skills = loaded_skills(launcher)
    expected_names = {plugin + ':' + skill for plugin, names in expected.items() for skill in names}
    bundled = {name for name in skills if ':' in name}
    assert bundled == expected_names, (bundled, expected_names)
    assert 'personal' in skills
    return skills


def assert_preserved():
    settings = tomllib.loads(config.read_text())
    assert settings['model'] == 'my-model'
    assert 'model_provider' not in settings
    assert '# personal settings' in config.read_text()
    assert auth.read_text() == '{"OPENAI_API_KEY":"test-api-key"}\n'
    assert session.read_text() == 'session sentinel\n'
