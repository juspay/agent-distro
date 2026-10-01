from pi_support import *

_, resolved = inventory()
assert 'command' in resolved['mcpServers']['kolu']
listing = json.loads(run('mcp', 'list', '--json'))
kolu = next(server for server in listing['servers'] if server['name'] == 'kolu')
assert kolu['state'] == 'connected', kolu
