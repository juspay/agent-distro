from pi_support import *

# The build-time translation produced the launcher and the MCP fragment, and
# the launch fused it into the user's mcp.json preserving their own entry.
run('--version')
user_mcp.write_text(json.dumps({'mcpServers': {'user-server': {'command': 'true'}}}))
user_settings.write_text(json.dumps({'personal': 'keep'}))
before_settings = user_settings.read_bytes(), user_settings.stat().st_ino
run('--version')
merged = json.loads(user_mcp.read_text())
assert 'user-server' in merged['mcpServers'], merged
assert json.loads(user_settings.read_text()) == {'personal': 'keep'}
assert_skills()
# Skills are served from the launcher's skill dirs, one SKILL.md each.
commands = rpc()
for name in skill_names():
    path = commands[f'skill:{name}']['sourceInfo']['path']
    assert path.endswith(f'/skills/{name}/SKILL.md'), path
assert (user_settings.read_bytes(), user_settings.stat().st_ino) == before_settings