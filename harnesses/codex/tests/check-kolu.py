from codex_support import *

# Codex keys a plugin's own settings by `<name>@<marketplace>`, and a launch
# registers the marketplace its contents name, so the id comes from a launch.
assert 'codex-cli' in run('--version', check=True).stdout
kolu_id = plugin_id('kolu')
config.write_text(config.read_text() + f'[plugins."{kolu_id}".mcp_servers.kolu]\nenabled_tools = ["my-tool"]\n')
for settings in ['0', '1']:
    env['AGENT_DISTRO_SETTINGS'] = settings
    assert 'codex-cli' in run('--version', check=True).stdout
    # Unchanged contents keep their marketplace, so the preference goes on
    # naming the plugin the launch enables.
    assert plugin_id('kolu') == kolu_id
    config_settings = tomllib.loads(config.read_text())
    assert config_settings['plugins'][kolu_id]['mcp_servers']['kolu']['enabled_tools'] == ['my-tool']
    assert_preserved()
servers = {s['name']: s for s in json.loads(run('mcp', 'list', '--json', check=True).stdout)}
assert {'personal', 'kolu'} <= servers.keys(), servers
assert_kolu_server(servers)
