from opencode2_support import *

original = check_inventory()
updated = check_inventory('opencode2-updated')
old_paths, new_paths = set(skill_paths(original)), set(skill_paths(updated))
assert old_paths and new_paths and old_paths.isdisjoint(new_paths), (original, updated)
check_inventory()
assert settings.read_bytes() == preserved

# AGENT_DISTRO_PLUGINS: the store fixture joins the session config for that launch.
fixture = os.environ['AGENT_DISTRO_TEST_PLUGIN']
locations = skill_locations(plugins=fixture)
assert any(l.endswith('/launch-fixture/launched/SKILL.md') for l in locations), locations
assert all(any(l.endswith(f'/{p}/{n}/SKILL.md') for l in locations) for p, names in expected.items() for n in names)
# A checkout named like a profile plugin replaces it.
name = next(iter(expected))
locations = skill_locations(plugins=checkout(name, 'shadowed'))
assert any(l.endswith(f'/{name}/shadowed/SKILL.md') for l in locations), locations
assert not any(l.endswith(f'/{name}/{n}/SKILL.md') for n in expected[name] for l in locations), locations
# Unset, the session config is the profile's again.
assert set(skill_paths(check_inventory())) == old_paths
assert settings.read_bytes() == preserved
