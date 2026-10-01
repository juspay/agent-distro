from pi_support import *

run('--version')  # the launcher's merge writes our servers into mcp.json
listing = json.loads(run('mcp', 'list', '--json').stdout)
servers = {server['name']: server for server in listing['servers']}
assert 'kolu' in servers, servers
assert servers['kolu']['state'] == 'connected', servers['kolu']
assert 'nixos' in servers, servers  # juspay's mcp-nixos server, via its launcher.
assert 'user-server' not in servers  # untouched by our merge.
