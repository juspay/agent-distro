from claude_support import *

assert '(Claude Code)' in run('--version')
plugins = json.loads(run('plugin', 'list', '--json'))
assert {p['id'] for p in plugins} == {p + '@inline' for p in expected}, plugins
assert all(p['enabled'] and p['scope'] == 'session' for p in plugins), plugins
for plugin, names in expected.items():
    assert inventory(plugin)[0] == set(names)
for plugin in plugins:
    run('plugin', 'validate', plugin['installPath'])

# A user's extra plugin composes with the profile's roots, including a spaced path.
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

# Claude Code's own attribution, as the API it talks to sees it: a launch asks
# for none, and a settings file of the user's decides it instead. The endpoint
# is this script's own, so the check needs neither credentials nor a network.
work = home / 'attribution'
work.mkdir()
assert 'Co-Authored-By' not in prompt(work), 'the launch asked for attribution of its own'
(work / '.claude').mkdir()
(work / '.claude/settings.json').write_text('{"attribution":{"commit":"Trailer: ours"}}')
assert 'Trailer: ours' in prompt(work), "the user's own attribution did not reach the model"
