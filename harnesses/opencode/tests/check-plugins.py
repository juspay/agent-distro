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


# A plugin's stdio MCP server runs in the launch directory (doc/index.md).
if 'acme.spec-fixture' in expected:
    spec = os.environ['AGENT_DISTRO_TEST_SPEC']
    for plugins in (None, spec):
        with tempfile.TemporaryDirectory() as launch, tempfile.TemporaryDirectory() as records:
            launch = os.path.realpath(launch)
            extra = {'FIXTURE_RECORDS': records}
            if plugins is not None:
                extra['AGENT_DISTRO_PLUGINS'] = plugins
            listing = subprocess.run(['opencode', '--pure', 'mcp', 'list'], cwd=launch, env=env | extra,
                                     text=True, capture_output=True, timeout=180)
            assert 'connected' in listing.stdout.lower(), (listing.stdout, listing.stderr)
            placeholders = json.loads(Path(records, 'placeholders.json').read_text())
            assert placeholders['cwd'] == launch, placeholders
            # A plugin's own `cwd` is its author's instruction, and still wins.
            explicit = json.loads(Path(records, 'explicit-cwd.json').read_text())
            assert explicit['cwd'] == os.path.join(os.path.realpath(spec), 'share'), explicit
