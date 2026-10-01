from pi_support import *

_, resolved = inventory()
assert 'command' in resolved['mcpServers']['kolu']
listing = json.loads(run('mcp', 'list', '--json'))
# Match the state of Kolu itself, not another server in the listing.
def has_connected_state(value):
    if isinstance(value, dict):
        return any(has_connected_state(item) for item in value.values())
    if isinstance(value, list):
        return any(has_connected_state(item) for item in value)
    return value == 'connected'


def connected(value):
    if isinstance(value, dict):
        if value.get('name') == 'kolu':
            return has_connected_state(value)
        if 'kolu' in value:
            return has_connected_state(value['kolu'])
        return any(connected(item) for item in value.values())
    if isinstance(value, list):
        return any(connected(item) for item in value)
    return False
assert connected(listing), listing
