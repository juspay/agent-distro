from opencode_support import *
# A plugin's stdio MCP server runs in the directory the harness was launched in.
# The plugin root is what the spec says (§7.2.1), and for a plugin from a flake
# reference it is under /nix/store, where `nix run github:…` cannot run at all.
spec = os.environ['AGENT_DISTRO_TEST_SPEC']


def launched(plugins):
    """`opencode mcp list` in a fresh launch directory, and what the servers recorded."""
    with tempfile.TemporaryDirectory() as launch, tempfile.TemporaryDirectory() as records:
        launch = os.path.realpath(launch)
        extra = {'FIXTURE_RECORDS': records}
        if plugins is not None:
            extra['AGENT_DISTRO_PLUGINS'] = plugins
        listing = subprocess.run(['opencode', '--pure', 'mcp', 'list'], cwd=launch, env=env | extra,
                                 text=True, capture_output=True, timeout=180)
        assert 'connected' in listing.stdout.lower(), (listing.stdout, listing.stderr)
        assert Path(records, 'placeholders.json').exists(), (listing.stdout, listing.stderr)
        return launch, {name: json.loads(Path(records, name + '.json').read_text())
                        for name in ('placeholders', 'explicit-cwd')}


# The profile's own plugin, then the same plugin from AGENT_DISTRO_PLUGINS: the
# built-in translation and the launch-time one must both carry the directory.
for plugins in (None, spec):
    launch, recorded = launched(plugins)
    assert recorded['placeholders']['cwd'] == launch, recorded['placeholders']
    # A plugin's own `cwd` is its author's instruction, and still wins.
    assert recorded['explicit-cwd']['cwd'] == os.path.join(os.path.realpath(spec), 'share'), recorded
