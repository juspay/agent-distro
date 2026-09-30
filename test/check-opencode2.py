from opencode_support import *

assert v2
assert re.search(r'2\.\d+\.\d+', run('--version'))
assert str(home) in run('debug', 'paths')
resolved = check_inventory()
configured = servers(resolved)
if 'kolu' in expected:
    assert configured['kolu']['type'] == 'local', configured
if 'acme.spec-fixture' in expected:
    assert configured['remote']['type'] == 'remote', configured
    assert configured['placeholders']['type'] == 'local', configured
    assert configured['bare']['type'] == 'local', configured
    assert 'invalid' not in configured
assert 'litellm' not in resolved.get('providers', {}), resolved
env['OPENCODE_CONFIG'] = '/does-not-exist'
result = subprocess.run([binary, '--version'], env=env, capture_output=True,
                        text=True, timeout=90, check=True)
assert 'replacing OPENCODE_CONFIG' in result.stderr, result.stderr
check_inventory()
assert settings.read_bytes() == preserved
