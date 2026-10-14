from opencode_support import *

resolved = check_inventory()
assert servers(resolved)['kolu']['type'] == 'local', resolved
listing = api('mcp')['data']
kolu = next(server for server in listing if server['name'] == 'kolu')
assert kolu['status']['status'] == 'connected', listing
