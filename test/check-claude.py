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

for path, contents in preserved.items():
    assert path.read_bytes() == contents, path
assert not (config_dir / 'plugins/installed_plugins.json').exists()
assert not (config_dir / 'plugins/known_marketplaces.json').exists()
