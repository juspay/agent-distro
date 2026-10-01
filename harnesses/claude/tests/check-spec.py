from claude_support import *

# Each fixture server records its argv, cwd and environment here on launch.
records = home / 'records'
records.mkdir()
env['FIXTURE_RECORDS'] = str(records)


def record(server):
    return json.loads((records / f'{server}.json').read_text())


listing = run('mcp', 'list')
for server in ['placeholders', 'explicit-cwd', 'data-cwd']:
    assert re.search(rf'^plugin:acme\.spec-fixture:{server}: .*Connected', listing, re.MULTILINE), listing
assert re.search(r'^plugin:mcp-only:bare: .*Connected', listing, re.MULTILINE), listing
# Mapped to Claude Code's name for Streamable HTTP; nothing listens there.
assert re.search(r'^plugin:acme\.spec-fixture:remote: http://127\.0\.0\.1:9/mcp \(HTTP\)', listing, re.MULTILINE), listing
# The invalid entry is skipped at build time, not handed to Claude Code.
assert 'invalid' not in listing, listing
assert re.search(r'MCP servers \(4\)', inventory('acme.spec-fixture')[1])

# PLUGIN_ROOT is the original plugin, where bundled files live, not the
# translated root Claude Code loads; PLUGIN_DATA is Claude Code's own.
placeholders = record('placeholders')
root, data = placeholders['env']['PLUGIN_ROOT'], placeholders['env']['PLUGIN_DATA']
assert root.startswith('/nix/store/') and root != placeholders['env']['CLAUDE_PLUGIN_ROOT'], placeholders
assert json.loads(Path(root, 'plugin.json').read_text())['name'] == 'acme.spec-fixture'
assert data == placeholders['env']['CLAUDE_PLUGIN_DATA'] and Path(data).is_dir(), placeholders
# Only the two placeholders expand, once each; everything else is literal.
assert placeholders['argv'] == [
    'placeholders', f'--root={root}', f'--data={data}/state', '${HOME}', '$HOME',
    '${PLUGIN_ROOT', root + data, 'it\'s "quoted" $(false) `false` *',
], placeholders
assert placeholders['env']['FIXTURE_CONFIG'] == root + '/share/README', placeholders
assert placeholders['env']['FIXTURE_DATA'] == data, placeholders
assert placeholders['env']['FIXTURE_LITERAL'] == '${HOME}', placeholders
assert placeholders['env']['FIXTURE-DASHED'] == 'dashed', placeholders
# cwd defaults to the plugin root, not Claude Code's launch directory.
assert placeholders['cwd'] == root, placeholders
assert record('explicit-cwd')['cwd'] == root + '/share'
assert record('data-cwd')['cwd'] == data

# A bare command is found on PATH; its PLUGIN_ROOT is its own plugin's.
bare = record('bare')
assert bare['argv'] == ['bare', bare['env']['PLUGIN_ROOT']] and bare['cwd'] == bare['env']['PLUGIN_ROOT'], bare
assert json.loads(Path(bare['cwd'], 'plugin.json').read_text())['name'] == 'mcp-only'

# Outside Claude Code, the launcher falls back to its own data directory.
launcher = re.search(r'^plugin:acme\.spec-fixture:data-cwd: (\S+)', listing, re.MULTILINE)[1]
fallback = {k: v for k, v in env.items() if k != 'CLAUDE_PLUGIN_DATA'}
fallback['XDG_DATA_HOME'] = str(home / 'xdg')
subprocess.run([launcher], env=fallback, stdin=subprocess.DEVNULL, timeout=60, check=True)
assert record('data-cwd')['cwd'] == str(home / 'xdg/agent-distro/plugins/acme.spec-fixture')
