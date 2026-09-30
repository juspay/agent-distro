from opencode_support import *

assert re.search(r'\d+\.\d+\.\d+', run('--version'))
resolved = check_inventory()
servers = resolved.get('mcp', {})
if 'kolu' in expected:
    assert servers['kolu']['type'] == 'local', servers
if 'acme.spec-fixture' in expected:
    assert servers['remote']['type'] == 'remote', servers
    assert servers['placeholders']['type'] == 'local', servers
    assert servers['bare']['type'] == 'local', servers
    assert 'invalid' not in servers
assert 'litellm' not in resolved.get('provider', {}), resolved
env['OPENCODE_CONFIG'] = '/does-not-exist'
result = subprocess.run(['opencode', '--pure', 'debug', 'config'], env=env,
                        capture_output=True, text=True, timeout=90, check=True)
assert 'replacing OPENCODE_CONFIG' in result.stderr, result.stderr
assert json.loads(result.stdout)['username'] == 'personal-user'
assert settings.read_bytes() == preserved
