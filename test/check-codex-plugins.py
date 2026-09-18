from codex_support import *

launcher = 'codex'
plugin_name = next(iter(expected))
plugin_id = plugin_name + '@' + marketplace
skill_plugin, skill = next((p, s) for p, names in expected.items() for s in names)
skill_name = skill_plugin + ':' + skill
skill_relative = skill_plugin + '/skills/' + skill + '/SKILL.md'
assert 'codex-cli' in run('--version', launcher=launcher, check=True).stdout
first_marketplace = marketplace_root()
assert first_marketplace.startswith('/nix/store/'), first_marketplace
for installed_id in [p + '@' + marketplace for p in expected]:
    plugin = installed_plugins()[installed_id]
    assert plugin['installed'] and plugin['enabled'], plugin

# Check the store-path regression before steady-state preferences, so reverting
# the adapter fails at the second build with Codex's different-source error.
launcher = 'codex-updated'
relaunch = run('--version', launcher=launcher)
assert relaunch.returncode == 0, relaunch.stderr
assert 'codex-cli' in relaunch.stdout
assert marketplace_root() != first_marketplace
launcher = 'codex'
run('--version', launcher=launcher, check=True)
assert marketplace_root() == first_marketplace

# Codex 0.154.0 has no `plugin disable` command; use its persistent setting.
enabled_setting = f'[plugins."{plugin_id}"]\nenabled = true'
disabled_setting = f'[plugins."{plugin_id}"]\nenabled = false'
assert enabled_setting in config.read_text()
config.write_text(config.read_text().replace(enabled_setting, disabled_setting))
disabled_config = config.read_bytes()
assert not installed_plugins()[plugin_id]['enabled']
assert 'codex-cli' in run('--version', launcher=launcher, check=True).stdout
assert marketplace_root() == first_marketplace
assert not installed_plugins()[plugin_id]['enabled']
assert config.read_bytes() == disabled_config

# A second build must replace the old registration and re-enable its plugins.
launcher = 'codex-updated'
relaunch = run('--version', launcher=launcher)
assert relaunch.returncode == 0, relaunch.stderr
assert 'codex-cli' in relaunch.stdout
store_marketplace = marketplace_root()
assert store_marketplace.startswith('/nix/store/'), store_marketplace
assert store_marketplace != first_marketplace
plugins = installed_plugins()
for installed_id in [p + '@' + marketplace for p in expected]:
    assert plugins[installed_id]['installed'] and plugins[installed_id]['enabled'], plugins


# Removing a plugin also stays in effect until a different build is launched.
# Run this after the preservation checks: Codex's explicit remove command
# deletes that plugin's own configuration, including its MCP preferences.
launcher = 'codex'
run('--version', launcher=launcher, check=True)
assert marketplace_root() == first_marketplace
skills = loaded_skills(launcher)

# A steady-state launch must leave cached contents alone.
# Use Codex's reported path instead of assuming its private cache layout.
cached_skill = Path(skills[skill_name]['path'])
cached_skill.chmod(0o644)  # Native installation preserves the store file's read-only mode.
cached_contents = '---\nname: stale\ndescription: stale cached skill\n---\n'
cached_skill.write_text(cached_contents)
run('--version', launcher=launcher, check=True)
assert cached_skill.read_text() == cached_contents

upstream('plugin', 'remove', plugin_id)
assert plugin_id not in installed_plugins()
removed_config = config.read_bytes()
run('--version', launcher=launcher, check=True)
assert marketplace_root() == first_marketplace
assert plugin_id not in installed_plugins()
assert config.read_bytes() == removed_config
launcher = 'codex-updated'
run('--version', launcher=launcher, check=True)
assert marketplace_root() == store_marketplace
# The changed path must replace the edited cache with the real bundled skill.
reinstalled_skills = loaded_skills(launcher)
reinstalled_skill = Path(reinstalled_skills[skill_name]['path'])
assert reinstalled_skill.read_text() != cached_contents
assert reinstalled_skill.read_text() == (Path(store_marketplace) / skill_relative).read_text()
plugin = installed_plugins()[plugin_id]
assert plugin['installed'] and plugin['enabled'], plugin
settings = tomllib.loads(config.read_text())
assert settings['model'] == 'my-model'
assert '# personal settings' in config.read_text()
assert auth.read_text() == '{"OPENAI_API_KEY":"test-api-key"}\n'
assert session.read_text() == 'session sentinel\n'
assert run('not-a-subcommand', launcher=launcher).returncode != 0

assert_preserved()
assert_skills(launcher)
invalid = 'model = [\n'
config.write_text(invalid)
assert run('--version', launcher=launcher).returncode != 0
assert config.read_text() == invalid
