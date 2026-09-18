from claude_support import *
assert re.search(r'MCP servers \(1\)\s+kolu\b', inventory('kolu')[1])
assert re.search(r'plugin:kolu:kolu: kolu mcp.*Connected', run('mcp', 'list'))
