from pi_support import *
# Kolu's plugin from AGENT_DISTRO_PLUGINS, as kolu sets it, on a profile without it.
kolu = os.environ['AGENT_DISTRO_TEST_KOLU']
_, resolved = inventory(plugins=kolu)
assert 'command' in resolved['mcpServers']['kolu']
listing = json.loads(run('mcp', 'list', '--json', overrides=with_plugins(kolu)))
server = next(server for server in listing['servers'] if server['name'] == 'kolu')
assert server['state'] == 'connected', server
# Unset, the next launch removes it again.
_, resolved = inventory()
assert 'kolu' not in resolved['mcpServers'], resolved
