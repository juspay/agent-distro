from claude_support import *
assert re.search(r'MCP servers \(1\)\s+kolu\b', inventory('kolu')[1])
# Claude Code sees the generated launcher, which runs `kolu mcp` from PATH. The
# translation is made at launch, into the cache (src/plugin/launch.ts), not
# into the store as it was when a profile was built in.
assert re.search(rf'plugin:kolu:kolu: {re.escape(str(translations))}/\S+/mcp-launchers/\S+ .*Connected',
                 run('mcp', 'list'))
