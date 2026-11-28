from agy_support import *

original = inventory()
assert original
# A profile whose plugins changed links their new translations.
updated = inventory('agy-changed')
assert all(updated[name] != target for name, target in original.items()), (original, updated)
assert inventory() == original

# AGENT_DISTRO_PLUGINS: the store fixture is linked for that launch...
fixture = os.environ['AGENT_DISTRO_TEST_PLUGIN']
inventory(value=fixture, wanted=set(expected) | {'launch-fixture'}, skills={**expected, 'launch-fixture': ['launched']})
# ...and a checkout named like a profile plugin replaces it.
name = next(iter(expected))
shadowed = inventory(value=checkout(name, 'shadowed'), skills={**expected, name: ['shadowed']})
assert shadowed[name] != original[name]
# Unset, the next launch takes the variable's plugins back.
assert inventory() == original
assert not (plugins / 'launch-fixture').exists()

# Without a home the plugins cannot be linked: the launch says so and starts
# without them, rather than not starting at all.
homeless = subprocess.run(['env', '-u', 'HOME', f'XDG_CACHE_HOME={Path.home()}/.cache',
                           f'AGENT_DISTRO_PLUGINS={fixture}', 'agy', '--version'],
                          env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
assert homeless.returncode == 0, homeless
assert 'HOME is unset; skipping plugin links' in homeless.stderr, homeless.stderr
assert linked() == original

# The Agent Plugins MCP shapes, as agy reads them: stdio servers through
# generated launchers, a Streamable HTTP server by its URL, the invalid one not
# at all.
if 'acme.spec-fixture' in expected:
    spec = servers('acme.spec-fixture')
    assert {'placeholders', 'explicit-cwd', 'data-cwd', 'remote'} <= spec.keys(), spec
    assert 'invalid' not in spec
    assert spec['remote'] == {'serverUrl': 'http://127.0.0.1:9/mcp', 'headers': {'X-Tenant': 'fixture'}}
    for server in ('placeholders', 'explicit-cwd', 'data-cwd'):
        assert os.access(spec[server]['command'], os.X_OK), spec[server]
