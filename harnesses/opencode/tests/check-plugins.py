from opencode_support import *

original = check_inventory()
updated = check_inventory('opencode-updated')
old_paths = set(original['skills']['paths'])
new_paths = set(updated['skills']['paths'])
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
assert check_inventory() == original
assert settings.read_bytes() == preserved
