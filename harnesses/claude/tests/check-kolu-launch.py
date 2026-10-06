from claude_support import *
# Kolu's plugin from AGENT_DISTRO_PLUGINS, as kolu sets it, on a profile without it.
kolu = os.environ['AGENT_DISTRO_TEST_KOLU']
assert 'kolu' not in expected
assert re.search(r'MCP servers \(1\)\s+kolu\b', inventory('kolu', plugins=kolu)[1])
listing = run('mcp', 'list', plugins=kolu)
assert re.search(r'plugin:kolu:kolu: \S+/agent-distro/plugins/store-\S+/claude/\S+/mcp-launchers/\S+ .*Connected', listing), listing
assert 'plugin:kolu' not in run('mcp', 'list')
