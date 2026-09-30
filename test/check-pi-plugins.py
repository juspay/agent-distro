from pi_support import *

# A rebuild must replace our skill roots while the user's own MCP servers
# and settings survive.
user_mcp.write_text(json.dumps({'mcpServers': {'user-server': {'command': 'true'}}}))
user_settings.write_text(json.dumps({'personal': 'keep'}))
run('--version')
first_skills = {name: rpc()[f'skill:{name}']['sourceInfo']['path'] for name in skill_names()}
run('--version', launcher='pi-updated')
second_skills = {name: rpc('pi-updated')[f'skill:{name}']['sourceInfo']['path']
                 for name in skill_names('pi-updated')}
# The rebuilt plugins land in new store paths, so the skill roots move.
assert set(second_skills) == set(first_skills), (first_skills, second_skills)
assert all(second_skills[name] != first_skills[name] for name in first_skills), (first_skills, second_skills)
# The user's MCP server and settings are untouched by the second build.
assert json.loads(user_mcp.read_text())['mcpServers']['user-server'] == {'command': 'true'}
assert json.loads(user_settings.read_text()) == {'personal': 'keep'}