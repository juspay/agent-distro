from pi_support import *

original, old_mcp = inventory()
discover()
updated, new_mcp = inventory('pi-updated')
discover('pi-updated')
assert original['skills'] and updated['skills']
assert set(original['skills']).isdisjoint(updated['skills']), (original, updated)
for name, server in old_mcp['mcpServers'].items():
    if name != 'personal' and 'command' in server:
        assert server['command'] != new_mcp['mcpServers'][name]['command']
        assert Path(new_mcp['mcpServers'][name]['command']).is_file()
restored, restored_mcp = inventory()
assert restored == original and restored_mcp == old_mcp
