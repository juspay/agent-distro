from pi_support import *

# Pi runs each stdio server through the generated launcher: the spec's
# environment, cwd and placeholders, with the plugin root as working
# directory. The recorder server proves it, as with Claude.
records = home / 'records'
records.mkdir()
env['FIXTURE_RECORDS'] = str(records)


def record(server):
    return json.loads((records / f'{server}.json').read_text())


run('--version')  # the launcher's merge writes our servers into mcp.json
listing = json.loads(run('mcp', 'list', '--json').stdout)
servers = {server['name']: server for server in listing['servers']}
for server in ['placeholders', 'explicit-cwd', 'data-cwd', 'bare']:
    assert servers[server]['state'] == 'connected', servers[server]
assert 'remote' in servers, servers  # streamable-http maps to a URL entry.
assert 'invalid' not in servers, servers  # skipped at build time.
assert 'sse' not in servers, servers  # SSE is unsupported; reported at build time.

placeholders = record('placeholders')
root, data = placeholders['env']['PLUGIN_ROOT'], placeholders['env']['PLUGIN_DATA']
assert root.startswith('/nix/store/'), placeholders
assert json.loads(Path(root, 'plugin.json').read_text())['name'] == 'acme.spec-fixture'
assert Path(data).is_dir(), placeholders
assert placeholders['argv'] == [
    'placeholders', f'--root={root}', f'--data={data}/state', '${HOME}', '$HOME',
    '${PLUGIN_ROOT', root + data, 'it\'s "quoted" $(false) `false` *',
], placeholders
assert placeholders['env']['FIXTURE_CONFIG'] == root + '/share/README', placeholders
assert placeholders['env']['FIXTURE_LITERAL'] == '${HOME}', placeholders
assert placeholders['env']['FIXTURE-DASHED'] == 'dashed', placeholders
assert placeholders['cwd'] == root, placeholders
assert record('explicit-cwd')['cwd'] == root + '/share', record('explicit-cwd')
assert record('data-cwd')['cwd'] == data, record('data-cwd')

bare = record('bare')
assert bare['argv'] == ['bare', bare['env']['PLUGIN_ROOT']] and bare['cwd'] == bare['env']['PLUGIN_ROOT'], bare
assert json.loads(Path(bare['cwd'], 'plugin.json').read_text())['name'] == 'mcp-only', bare
