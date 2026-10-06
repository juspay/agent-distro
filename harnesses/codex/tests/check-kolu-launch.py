from codex_support import *
# Kolu's plugin from AGENT_DISTRO_PLUGINS, as kolu sets it, on a profile without it.
kolu = os.environ['AGENT_DISTRO_TEST_KOLU']
before = config.read_bytes()
servers = {s['name']: s for s in json.loads(run('mcp', 'list', '--json', plugins=kolu, check=True).stdout)}
assert {'personal', 'kolu'} <= servers.keys(), servers
assert servers['kolu']['enabled']
assert servers['kolu']['transport']['command'] == 'kolu'
assert servers['kolu']['transport']['args'] == ['mcp']
assert config.read_bytes() == before
servers = {s['name'] for s in json.loads(run('mcp', 'list', '--json', check=True).stdout)}
assert 'kolu' not in servers, servers
assert_preserved()
