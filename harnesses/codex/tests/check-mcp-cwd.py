from codex_support import *
import tempfile

# A plugin's stdio MCP server runs in the directory the harness was launched in.
# The plugin root is what the spec says (§7.2.1), and for a plugin from a flake
# reference it is under /nix/store, where `nix run github:…` cannot run at all.
#
# The fixture is `mcp-only` and not the dotted spec fixture: Codex's `-c` splits
# a key at every `.`, so a plugin named `acme.spec-fixture` is reported and
# skipped for one launch (harnesses/codex/README.md).
spec = os.environ['AGENT_DISTRO_TEST_MCP']


def launched(plugins):
    """The server Codex lists for the plugin, started as Codex starts it.

    `codex mcp list` does not connect, so the record comes from running the
    command it names, from the directory Codex reads the plugin in — the cwd
    that made this fail — with the launch directory in AGENT_DISTRO_CWD, as the
    launcher exports it.
    """
    with tempfile.TemporaryDirectory() as launch, tempfile.TemporaryDirectory() as records:
        launch = os.path.realpath(launch)
        listing = json.loads(run('mcp', 'list', '--json', plugins=plugins, check=True).stdout)
        server = next(entry for entry in listing if entry['name'] == 'bare')
        command = server['transport']['command']
        # Codex reads the plugin's own mcp.json, so the command is the launcher
        # of a copy — never the fixture's own `fixture-record` — and it is
        # plugin-relative, as §7.2.1 requires of `command`.
        assert command == './bin/mcp-only-0-bare', server
        # Codex installed the copy into its cache; run that launcher from the
        # copy's own directory, the cwd Codex reads the plugin in.
        launcher = next(codex_home.glob(f'plugins/cache/agent-distro-*/mcp-only/*/bin/mcp-only-0-bare'))
        subprocess.run([str(launcher)], cwd=str(launcher.parents[1]),
                       env=os.environ | {'FIXTURE_RECORDS': records, 'AGENT_DISTRO_CWD': launch},
                       stdin=subprocess.DEVNULL, timeout=60)
        assert Path(records, 'bare.json').exists(), os.listdir(records)
        return launch, json.loads(Path(records, 'bare.json').read_text())


# The profile's own plugin, then the same plugin from AGENT_DISTRO_PLUGINS: the
# built-in copy and the launch-time translation must both carry the directory.
for plugins in (None, spec):
    launch, record = launched(plugins)
    assert record['cwd'] == launch, record
    assert record['argv'] == ['bare', record['env']['PLUGIN_ROOT']], record
