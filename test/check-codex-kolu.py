from codex_support import *
config.write_text(config.read_text() + f'[plugins."kolu@{marketplace}".mcp_servers.kolu]\nenabled_tools = ["my-tool"]\n')
for gateway in ['0', '1']:
    env['AI_GATEWAY'] = gateway
    assert 'codex-cli' in run('--version', check=True).stdout
    settings = tomllib.loads(config.read_text())
    assert settings['plugins']['kolu@' + marketplace]['mcp_servers']['kolu']['enabled_tools'] == ['my-tool']
    assert_preserved()
servers = {s['name']: s for s in json.loads(run('mcp', 'list', '--json', check=True).stdout)}
assert {'personal', 'kolu'} <= servers.keys(), servers
assert servers['kolu']['enabled']
assert servers['kolu']['transport']['command'] == 'kolu'
assert servers['kolu']['transport']['args'] == ['mcp']
