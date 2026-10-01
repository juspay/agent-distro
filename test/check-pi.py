from pi_support import *

# The build-time translation produced the launcher and the MCP fragment, and
# the launch fused it into the user's mcp.json preserving their own entry.
run('--version')
user_mcp.write_text(json.dumps({'mcpServers': {'user-server': {'command': 'true'}}}))
user_settings.write_text(json.dumps({'personal': 'keep'}))
run('--version')
merged = json.loads(user_mcp.read_text())
assert 'user-server' in merged['mcpServers'], merged
settings = json.loads(user_settings.read_text())
assert settings['personal'] == 'keep', settings
assert 'skills' in settings, settings  # our materialised skill dirs.
assert_skills()
# Skills are served from the materialised skill dir (one SKILL.md each).
commands = rpc()
for name in skill_names():
    path = commands[f'skill:{name}']['sourceInfo']['path']
    assert path.endswith(f'/{name}/SKILL.md'), path
# The second launch rewrote our entries in place; the user's own survive.
assert json.loads(user_mcp.read_text())['mcpServers']['user-server'] == {'command': 'true'}
