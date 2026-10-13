from codex_support import *
import tempfile

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

# AGENT_DISTRO_PLUGINS: the store fixture joins for one launch, through -c
# overrides; config.toml never learns of it.
fixture = os.environ['AGENT_DISTRO_TEST_PLUGIN']
settled = config.read_bytes()
skills = loaded_skills(launcher, plugins=fixture)
assert 'launch-fixture:launched' in skills, skills
assert {s for s in skills if ':' in s} == {p + ':' + s for p, names in expected.items() for s in names} | {'launch-fixture:launched'}
# A checkout named like a profile plugin replaces it for that launch.
name = next(p for p in expected if '.' not in p)
skills = loaded_skills(launcher, plugins=checkout(name, 'shadowed'))
assert {s for s in skills if s.startswith(name + ':')} == {name + ':shadowed'}, skills
assert config.read_bytes() == settled
assert 'launch-fixture' not in json.dumps(json.loads(upstream('plugin', 'marketplace', 'list', '--json').stdout))
# Unset, the profile's plugins are exactly what loads.
assert_skills(launcher)

# A plugin's stdio MCP server runs in the launch directory (doc/index.md).
if 'acme.spec-fixture' in expected:
    spec = os.environ['AGENT_DISTRO_TEST_SPEC']
    for plugins in (None, spec):
        with tempfile.TemporaryDirectory() as launch, tempfile.TemporaryDirectory() as records:
            launch = os.path.realpath(launch)
            # The listing is what the assertions below read.
            result = run('mcp', 'list', '--json', plugins=plugins)
            assert result.stdout.strip(), result
            servers = {entry['name']: entry for entry in json.loads(result.stdout)}
            assert servers['placeholders']['transport']['command'].endswith('bin/acme.spec-fixture-0-placeholders'), servers
            for name in ['placeholders', 'explicit-cwd']:
                installed = next(codex_home.glob(f'plugins/cache/*/acme.spec-fixture/*/bin/acme.spec-fixture-*-{name}'))
                subprocess.run([str(installed)], cwd=str(installed.parents[1]),
                               env=os.environ | {'FIXTURE_RECORDS': records, 'AGENT_DISTRO_CWD': launch},
                               stdin=subprocess.DEVNULL, timeout=60)
            placeholders = json.loads(Path(records, 'placeholders.json').read_text())
            assert placeholders['cwd'] == launch, placeholders
            # A plugin's own `cwd` is its author's instruction, and still wins.
            explicit = json.loads(Path(records, 'explicit-cwd.json').read_text())
            assert explicit['cwd'] == os.path.join(os.path.realpath(spec), 'share'), explicit

invalid = 'model = [\n'
config.write_text(invalid)
assert run('--version', launcher=launcher).returncode != 0
assert config.read_text() == invalid
