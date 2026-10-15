from codex_support import *
import tempfile

# A plugin whose name contains "." cannot be enabled with Codex's `-c`: its key
# splits at every dot and a quoted key does not take, so the adapter registers
# its marketplace and leaves the plugin disabled, saying so. Everything below
# is about the plugins a launch does enable.
expected = {name: names for name, names in expected.items() if '.' not in name}

launcher = 'codex'
# The plugin this check removes, which stays removed for the unchanged
# profile: never the spec fixture, whose install the stdio-server checks below
# launch with that profile need.
plugin_name = next(p for p in expected if p != 'acme.spec-fixture')
skill_plugin, skill = next((p, s) for p, names in expected.items() for s in names)
skill_name = skill_plugin + ':' + skill
skill_relative = skill_plugin + '/skills/' + skill + '/SKILL.md'
assert 'codex-cli' in run('--version', launcher=launcher, check=True).stdout

# A launch registers each of the profile's plugins as a marketplace of its own,
# named after that plugin's content, and enables it for that launch alone.
first = launched_plugins()
assert set(first) == set(expected), first
assert len({p['marketplaceName'] for p in first.values()}) == len(expected), first
for name, plugin in first.items():
    assert plugin['installed'] and plugin['enabled'], plugin
    assert plugin['pluginId'] == name + '@' + plugin['marketplaceName'], plugin
    # Codex installs from the adapter's cached translation, never from a store
    # path, which `nix run github:…` could not run a server from.
    assert plugin['marketplaceSource']['source'].startswith(str(translations) + '/'), plugin
identifier = first[plugin_name]['pluginId']
first_marketplace = first[plugin_name]['marketplaceName']
installed_marketplaces = {p['marketplaceName'] for p in first.values()}
assert installs() == installed_marketplaces, installs()

# Unchanged contents keep their marketplace: a re-launch installs nothing new.
run('--version', launcher=launcher, check=True)
assert launched_plugins() == first
assert installs() == installed_marketplaces

# Rebuilt plugins are other contents: new marketplaces, installed beside the
# first ones, which the launcher with the unchanged profile goes on using.
launcher = 'codex-changed'
relaunch = run('--version', launcher=launcher)
assert relaunch.returncode == 0, relaunch.stderr
assert 'codex-cli' in relaunch.stdout
changed = launched_plugins(launcher)
assert set(changed) == set(expected), changed
changed_marketplaces = {p['marketplaceName'] for p in changed.values()}
assert changed_marketplaces.isdisjoint(installed_marketplaces), changed
assert installs() == installed_marketplaces | changed_marketplaces, installs()
launcher = 'codex'
run('--version', launcher=launcher, check=True)
assert marketplace_of(plugin_name) == first_marketplace

# Codex 0.154.0 has no `plugin disable` command; use its persistent setting.
# A launch writes none of its own, so the file stays as the user left it; the
# `-c` overrides enable the profile's plugins for the launch regardless.
config.write_text(config.read_text() + f'[plugins."{identifier}"]\nenabled = false\n')
disabled_config = config.read_bytes()
assert 'codex-cli' in run('--version', launcher=launcher, check=True).stdout
assert config.read_bytes() == disabled_config
assert launched_plugins()[plugin_name] == first[plugin_name]

# A steady-state launch must leave cached contents alone.
# Use Codex's reported path instead of assuming its private cache layout.
skills = loaded_skills(launcher)
cached_skill = Path(skills[skill_name]['path'])
assert cached_skill.is_relative_to(install_cache / first[skill_plugin]['marketplaceName']), cached_skill
cached_skill.chmod(0o644)  # Native installation preserves the store file's read-only mode.
cached_contents = '---\nname: stale\ndescription: stale cached skill\n---\n'
cached_skill.write_text(cached_contents)
run('--version', launcher=launcher, check=True)
assert cached_skill.read_text() == cached_contents
assert config.read_bytes() == disabled_config

# Removing a plugin also stays in effect until its contents change: Codex
# empties its marketplace's install, and a launch installs only a marketplace
# its cache directory lacks. The command needs the registration a launch
# passes, so it runs through the launcher. Run this after the preservation
# checks: Codex's explicit remove command deletes that plugin's own
# configuration, including its MCP preferences.
run('plugin', 'remove', identifier, launcher=launcher, check=True)
assert identifier not in installed_plugins()
assert first_marketplace in installs()
removed_config = config.read_bytes()
run('--version', launcher=launcher, check=True)
remaining = launched_plugins()
assert set(remaining) == set(expected) - {plugin_name}, remaining
assert all(plugin == first[name] for name, plugin in remaining.items()), remaining
assert config.read_bytes() == removed_config

# Rebuilt contents are a marketplace the cache lacks, so that launch installs
# afresh: the removed plugin is back and the edited cache is replaced by the
# plugin's own skill.
launcher = 'codex-changed'
run('--version', launcher=launcher, check=True)
reinstalled = launched_plugins(launcher)
assert set(reinstalled) == set(expected), reinstalled
for name, plugin in reinstalled.items():
    assert plugin['installed'] and plugin['enabled'], plugin
    assert plugin['marketplaceName'] == changed[name]['marketplaceName'], (plugin, changed[name])
reinstalled_skill = Path(loaded_skills(launcher)[skill_name]['path'])
assert reinstalled_skill != cached_skill
assert reinstalled_skill.read_text() != cached_contents
assert reinstalled_skill.read_text() == (
    Path(marketplace_root(skill_plugin, launcher)) / skill_relative).read_text()
assert run('not-a-subcommand', launcher=launcher).returncode != 0

assert_preserved()
assert_skills(launcher)
# config.toml learns of no launch: no marketplace, and no plugin but the entry
# this check wrote itself. Codex without a profile is the second reading.
settings = tomllib.loads(config.read_text())
assert 'marketplaces' not in settings, settings
assert set(settings.get('plugins', {})) <= {identifier}, settings
assert json.loads(upstream('plugin', 'marketplace', 'list', '--json').stdout)['marketplaces'] == []

# AGENT_DISTRO_PLUGINS: the store fixture joins for one launch, through -c
# overrides; config.toml never learns of it.
fixture = os.environ['AGENT_DISTRO_TEST_PLUGIN']
settled = config.read_bytes()
skills = loaded_skills(launcher, plugins=fixture)
assert 'launch-fixture:launched' in skills, skills
assert {s for s in skills if ':' in s} == {p + ':' + s for p, names in expected.items() for s in names} | {'launch-fixture:launched'}
# The launch plugin gets a marketplace of its own too, none of the profile's.
launch_fixture = launched_plugins(launcher, plugins=fixture)['launch-fixture']
assert launch_fixture['marketplaceName'] not in installed_marketplaces | changed_marketplaces, launch_fixture
# Its install is inert without that launch's overrides.
assert 'launch-fixture' not in launched_plugins(launcher)
# A checkout named like a profile plugin replaces it for that launch.
name = next(p for p in expected if '.' not in p)
skills = loaded_skills(launcher, plugins=checkout(name, 'shadowed'))
assert {s for s in skills if s.startswith(name + ':')} == {name + ':shadowed'}, skills
assert config.read_bytes() == settled
assert json.loads(upstream('plugin', 'marketplace', 'list', '--json').stdout)['marketplaces'] == []
# Unset, the profile's plugins are exactly what loads.
assert_skills(launcher)

# A plugin's stdio MCP server runs in the launch directory (doc/index.md).
if 'acme.spec-fixture' in expected:
    spec = os.environ['AGENT_DISTRO_TEST_SPEC']
    for plugins in (None, spec):
        with tempfile.TemporaryDirectory() as launch, tempfile.TemporaryDirectory() as records:
            launch = os.path.realpath(launch)
            # The unchanged profile, whose spec plugin is AGENT_DISTRO_TEST_SPEC
            # itself: the `cwd` asserted below is that directory's. The listing
            # is what the assertions below read.
            result = run('mcp', 'list', '--json', plugins=plugins)
            assert result.stdout.strip(), result
            servers = {entry['name']: entry for entry in json.loads(result.stdout)}
            assert servers['placeholders']['transport']['command'].endswith('bin/acme.spec-fixture-0-placeholders'), servers
            # The profile's plugin and the one AGENT_DISTRO_PLUGINS names are
            # installed under the marketplace their contents name.
            root = install_cache / marketplace_of('acme.spec-fixture', plugins=plugins)
            for name in ['placeholders', 'explicit-cwd']:
                installed = next(root.glob(f'acme.spec-fixture/*/bin/acme.spec-fixture-*-{name}'))
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
