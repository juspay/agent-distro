from opencode_support import *

resolved = check_inventory()
assert resolved['mcp']['kolu:kolu']['type'] == 'local', resolved
listing = run('mcp', 'list')
assert 'kolu:kolu' in listing and 'connected' in listing.lower(), listing
