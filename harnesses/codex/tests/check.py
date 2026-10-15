from codex_support import *

pristine = config.read_bytes()
assert 'codex-cli' in run('--version', check=True).stdout
# Registration is `-c` overrides only: config.toml learns nothing of a launch.
assert config.read_bytes() == pristine
assert_skills()
# The profile's plugins are exactly what a launch installs and enables, each
# under a marketplace of its own.
launched = launched_plugins()
assert set(launched) == set(expected), launched
assert len({p['marketplaceName'] for p in launched.values()}) == len(expected), launched
for name, plugin in launched.items():
    assert plugin['installed'] and plugin['enabled'], plugin
    assert plugin['pluginId'] == name + '@' + plugin['marketplaceName'], plugin
assert config.read_bytes() == pristine
assert_preserved()
# A user's own registration that does not resolve must not stop this launch:
# ours is `-c` overrides only, so theirs stays exactly as written.
broken = '/nix/store/00000000000000000000000000000000-user-marketplace'
assert not Path(broken).exists()
config.write_text(config.read_text() + f'\n[marketplaces.personal]\nsource = "{broken}"\n')
launched = launched_plugins()
assert set(launched) == set(expected), launched
for name, plugin in launched.items():
    assert plugin['installed'] and plugin['enabled'], plugin
assert_preserved()
settings = tomllib.loads(config.read_text())
assert settings['marketplaces']['personal']['source'] == broken, settings
assert run('not-a-subcommand').returncode != 0
invalid = 'model = [\n'
config.write_text(invalid)
assert run('mcp', 'list', '--json').returncode != 0
assert config.read_text() == invalid
