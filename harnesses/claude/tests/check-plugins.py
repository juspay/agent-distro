from claude_support import *

assert '(Claude Code)' in run('--version')
plugins = json.loads(run('plugin', 'list', '--json'))
assert {p['id'] for p in plugins} == {p + '@inline' for p in expected}, plugins
assert all(p['enabled'] and p['scope'] == 'session' for p in plugins), plugins
for plugin, names in expected.items():
    assert inventory(plugin)[0] == set(names)
for plugin in plugins:
    run('plugin', 'validate', plugin['installPath'])

# A user's extra plugin composes with the bundled roots, including a spaced path.
personal = home / 'personal plugin'
(personal / '.claude-plugin').mkdir(parents=True)
(personal / '.claude-plugin/plugin.json').write_text('{"name":"personal"}')
(personal / 'skills' / 'personal').mkdir(parents=True)
(personal / 'skills/personal/SKILL.md').write_text('---\nname: personal\ndescription: Personal skill\n---\n')
extra = json.loads(run('--plugin-dir', str(personal), 'plugin', 'list', '--json'))
assert {p['id'] for p in extra} == {p + '@inline' for p in expected} | {'personal@inline'}, extra

# A second build must discover its new roots in the same existing home.
updated = json.loads(run('plugin', 'list', '--json', launcher='claude-updated'))
assert {p['id'] for p in updated} == {p + '@inline' for p in expected}, updated
previous_paths = {p['installPath'] for p in plugins}
assert all(p['enabled'] and p['scope'] == 'session' for p in updated), updated
assert all(p['installPath'].startswith('/nix/store/') and
           p['installPath'] not in previous_paths for p in updated), updated
for plugin, names in expected.items():
    assert inventory(plugin, launcher='claude-updated')[0] == set(names)

# AGENT_DISTRO_PLUGINS: a store plugin the profile lacks joins for that launch.
fixture = os.environ['AGENT_DISTRO_TEST_PLUGIN']
launched = json.loads(run('plugin', 'list', '--json', plugins=fixture))
assert {p['id'] for p in launched} == {p + '@inline' for p in expected} | {'launch-fixture@inline'}, launched
added = next(p for p in launched if p['id'] == 'launch-fixture@inline')
assert added['scope'] == 'session' and '/agent-distro/plugins/store-' in added['installPath'], added
assert inventory('launch-fixture', plugins=fixture)[0] == {'launched'}

# A checkout named like a profile plugin replaces it, whatever its version.
name = next(iter(expected))
shadow = checkout(name, 'shadowed')
shadowed = json.loads(run('plugin', 'list', '--json', plugins=shadow))
assert {p['id'] for p in shadowed} == {p + '@inline' for p in expected}, shadowed
replaced = next(p for p in shadowed if p['id'] == name + '@inline')
assert '/agent-distro/plugins/sha256-' in replaced['installPath'], replaced
assert inventory(name, plugins=shadow)[0] == {'shadowed'}

# Unset, the launch is the profile's again.
identify = lambda listing: {(p['id'], p['installPath']) for p in listing}
assert identify(json.loads(run('plugin', 'list', '--json'))) == identify(plugins)
assert inventory(name)[0] == set(expected[name])

for path, contents in preserved.items():
    assert path.read_bytes() == contents, path
assert not (config_dir / 'plugins/installed_plugins.json').exists()
assert not (config_dir / 'plugins/known_marketplaces.json').exists()
