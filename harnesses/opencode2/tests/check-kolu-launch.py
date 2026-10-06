from opencode2_support import *
# Kolu's plugin from AGENT_DISTRO_PLUGINS, as kolu sets it, on a profile without it.
kolu = os.environ['AGENT_DISTRO_TEST_KOLU']
assert servers(config(plugins=kolu))['kolu']['type'] == 'local'
listing = api('mcp', plugins=kolu)['data']
server = next(server for server in listing if server['name'] == 'kolu')
assert server['status']['status'] == 'connected', listing
assert 'kolu' not in servers(config())
