from opencode_support import *

resolved = check_inventory()
assert resolved['mcp']['kolu']['type'] == 'local', resolved
listing = run('mcp', 'list')
assert 'kolu' in listing and 'connected' in listing.lower(), listing
