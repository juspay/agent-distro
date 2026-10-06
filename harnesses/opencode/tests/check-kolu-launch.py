from opencode_support import *
# Kolu's plugin from AGENT_DISTRO_PLUGINS, as kolu sets it, on a profile without it.
kolu = os.environ['AGENT_DISTRO_TEST_KOLU']
resolved = config(plugins=kolu)
assert resolved['mcp']['kolu']['type'] == 'local', resolved
listing = run('mcp', 'list', plugins=kolu)
assert 'kolu' in listing and 'connected' in listing.lower(), listing
assert 'kolu' not in config().get('mcp', {})
