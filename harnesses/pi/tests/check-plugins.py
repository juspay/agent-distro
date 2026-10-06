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

# AGENT_DISTRO_PLUGINS: the store fixture is merged for that launch...
fixture = os.environ['AGENT_DISTRO_TEST_PLUGIN']
discover(plugins=fixture, skills=expected_skills | {'launched'})
launched, _ = inventory(plugins=fixture)
assert any(path.endswith('/skills/launch-fixture') for path in launched['skills']), launched
# ...and a checkout named like a profile plugin replaces it.
name = next(iter(expected))
others = {skill for plugin, skills in expected.items() if plugin != name for skill in skills}
discover(plugins=checkout(name, 'shadowed'), skills=others | {'shadowed'})
# Unset, the next launch takes it all back: Pi's files are the profile's again.
assert inventory() == (original, old_mcp)
assert not (agent_dir / '.agent-distro-launch.json').exists()
discover()
