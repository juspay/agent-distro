from claude_support import *
assert re.search(r'MCP servers \(1\)\s+kolu\b', inventory('kolu')[1])
# Claude Code sees the generated launcher, which runs `kolu mcp` from PATH.
assert re.search(r'plugin:kolu:kolu: /nix/store/\S+-claude-plugin/mcp-launchers/\S+ .*Connected', run('mcp', 'list'))
