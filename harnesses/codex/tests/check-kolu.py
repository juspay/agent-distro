from codex_support import *
config.write_text(config.read_text() + f'[plugins."kolu@{marketplace}".mcp_servers.kolu]\nenabled_tools = ["my-tool"]\n')
for settings in ['0', '1']:
    env['AGENT_DISTRO_SETTINGS'] = settings
    assert 'codex-cli' in run('--version', check=True).stdout
    config_settings = tomllib.loads(config.read_text())
    assert config_settings['plugins']['kolu@' + marketplace]['mcp_servers']['kolu']['enabled_tools'] == ['my-tool']
    assert_preserved()
servers = {s['name']: s for s in json.loads(run('mcp', 'list', '--json', check=True).stdout)}
assert {'personal', 'kolu'} <= servers.keys(), servers
assert_kolu_server(servers)
