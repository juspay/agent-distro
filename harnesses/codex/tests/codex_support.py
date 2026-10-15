import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tomllib

expected = json.loads(sys.argv[1])
# A plugin whose name contains "." cannot be enabled with Codex's `-c` — its
# key splits at every dot, and a quoted key does not take — so the adapter
# registers its marketplace and leaves the plugin disabled, saying so. Every
# check over this support is about the plugins a launch does enable.
expected = {name: names for name, names in expected.items() if '.' not in name}
# A plugin gets a marketplace of its own, named after its cache key
# (src/harness/codex.ts), so all argv[2] can carry is the prefix they share;
# a check that needs a marketplace derives it from `codex plugin list --json`.
marketplace_prefix = sys.argv[2]
home = Path.home()
codex_home = home / 'relocated-codex'
codex_home.mkdir()
# Where Codex keeps its installs, and where the adapter keeps the translations
# it registers as marketplaces (src/plugin/launch.ts); neither is a store path.
install_cache = codex_home / 'plugins' / 'cache'
translations = Path(os.environ.get('XDG_CACHE_HOME') or home / '.cache') / 'agent-distro' / 'plugins'
env = dict(os.environ, CODEX_HOME=str(codex_home), AGENT_DISTRO_SETTINGS='0')
config = codex_home / 'config.toml'
config.write_text('# personal settings\nmodel = "my-model"\n[mcp_servers.personal]\ncommand = "true"\n')
auth = codex_home / 'auth.json'
auth.write_text('{"OPENAI_API_KEY":"test-api-key"}\n')
session = codex_home / 'sessions' / 'keep.jsonl'
session.parent.mkdir()
session.write_text('session sentinel\n')
skill = codex_home / 'skills' / 'personal' / 'SKILL.md'
skill.parent.mkdir(parents=True)
skill.write_text('---\nname: personal\ndescription: Personal skill\n---\n')


def with_plugins(plugins):
    # AGENT_DISTRO_PLUGINS for one launch only.
    return env if plugins is None else env | {'AGENT_DISTRO_PLUGINS': plugins}


def run(*args, launcher='codex', plugins=None, **kwargs):
    """One Codex run. A caller's `check=True` still raises, but with the
    command's own words: `subprocess`'s own error throws the stderr away, and
    that is the evidence a failing check needs."""
    check = kwargs.pop('check', False)
    result = subprocess.run([launcher, *args], env=with_plugins(plugins), text=True,
                            capture_output=True, timeout=60, **kwargs)
    if check:
        assert result.returncode == 0, (result.stdout, result.stderr)
    return result


def assert_kolu_server(servers):
    """The kolu plugin's server reaches Codex through a generated launcher.

    Codex starts a plugin's stdio servers in the plugin root — the spec's
    default, and a /nix/store path for a plugin from a flake reference, where
    `nix run github:…` cannot run — so the adapter installs a copy whose
    `mcp.json` names a launcher, which runs the plugin's own command in the
    directory Codex was launched in (doc/index.md).
    """
    server = servers['kolu']
    assert server['enabled'], server
    assert server['transport']['command'].endswith('bin/kolu-0-kolu'), server
    assert server['transport']['args'] == [], server
    # And it runs: the fixture answers an MCP initialize as kolu's server.
    launchers = list(codex_home.glob('plugins/cache/*/kolu/*/bin/kolu-0-kolu'))
    assert len(launchers) == 1, launchers
    launcher = launchers[0]
    started = subprocess.run([str(launcher)], text=True, capture_output=True, timeout=60,
                             input='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n')
    assert json.loads(started.stdout.splitlines()[0])['result']['serverInfo']['name'] == 'kolu-test', started


def upstream(*args):
    # A launcher with no profile: what Codex sees from config.toml alone.
    return subprocess.run(['codex-upstream', *args], env=env, text=True,
                          capture_output=True, timeout=60, check=True)


def installed_plugins(launcher='codex', plugins=None):
    """Codex's installed plugins during a launch, keyed by pluginId.

    A launch registers its marketplaces with `-c` and writes none of them, so
    only a launcher's own invocation lists them; codex-upstream lists nothing.
    """
    listing = run('plugin', 'list', '--json', launcher=launcher, plugins=plugins, check=True)
    return {plugin['pluginId']: plugin for plugin in json.loads(listing.stdout)['installed']}


def launched_plugins(launcher='codex', plugins=None):
    """The same, keyed by name: a launch registers each plugin once, under its
    own `agent-distro-` marketplace."""
    by_name = {}
    for plugin in installed_plugins(launcher, plugins).values():
        assert plugin['marketplaceName'].startswith(marketplace_prefix), plugin
        assert plugin['name'] not in by_name, (plugin, by_name)
        by_name[plugin['name']] = plugin
    return by_name


def marketplace_of(name, launcher='codex', plugins=None):
    """The marketplace a launch installs `name` under. It is named after the
    plugin's content, so it is the same for every launch of that content and
    another one once the plugin is rebuilt."""
    return launched_plugins(launcher, plugins)[name]['marketplaceName']


def plugin_id(name, launcher='codex', plugins=None):
    """`<name>@<marketplace>`, as Codex keys a plugin's own settings."""
    return launched_plugins(launcher, plugins)[name]['pluginId']


def marketplace_root(name, launcher='codex', plugins=None):
    """What Codex installed `name` from: the adapter's cached translation,
    holding the plugin under its own name."""
    root = launched_plugins(launcher, plugins)[name]['marketplaceSource']['source']
    assert root.startswith(str(translations) + '/'), (root, str(translations))
    return root


def installs():
    """The marketplace directories Codex has installed into."""
    return {entry.name for entry in install_cache.iterdir()} if install_cache.exists() else set()


def loaded_skills(launcher='codex', plugins=None):
    # No thread or model request: initialize, then ask the real app server for
    # its effective skills. A timeout also catches protocol changes in updates.
    process = subprocess.Popen([launcher, 'app-server'], env=with_plugins(plugins),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True)
    def request(request_id, method, params):
        process.stdin.write(json.dumps({'id': request_id, 'method': method, 'params': params}) + '\n')
        process.stdin.flush()
        for line in process.stdout:
            response = json.loads(line)
            if response.get('id') == request_id:
                assert 'error' not in response, response
                return response['result']
        raise AssertionError('Codex exited without answering ' + method)

    def timeout(*_):
        raise TimeoutError('Codex skill discovery timed out')

    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(60)
    try:
        request(1, 'initialize', {'clientInfo': {'name': 'ai-test', 'version': '1'},
                                  'capabilities': {'experimentalApi': True}})
        process.stdin.write('{"method":"initialized"}\n')
        process.stdin.flush()
        result = request(2, 'skills/list', {'cwds': [str(home)], 'forceReload': True})
        entry = result['data'][0]
        assert not entry['errors'], entry['errors']
        return {skill['name']: skill for skill in entry['skills'] if skill['enabled']}
    finally:
        signal.alarm(0)
        process.terminate()
        process.wait(timeout=10)



def assert_skills(launcher='codex'):
    skills = loaded_skills(launcher)
    expected_names = {plugin + ':' + skill for plugin, names in expected.items() for skill in names}
    from_plugins = {name for name in skills if ':' in name}
    assert from_plugins == expected_names, (from_plugins, expected_names)
    assert 'personal' in skills
    return skills


def assert_preserved():
    settings = tomllib.loads(config.read_text())
    assert settings['model'] == 'my-model'
    assert 'model_provider' not in settings
    assert '# personal settings' in config.read_text()
    assert auth.read_text() == '{"OPENAI_API_KEY":"test-api-key"}\n'
    assert session.read_text() == 'session sentinel\n'


def checkout(name, skill):
    """A plugin working copy outside the store, as a user edits one."""
    root = home / 'checkouts' / name
    (root / 'skills' / skill).mkdir(parents=True)
    (root / 'plugin.json').write_text(json.dumps({
        '$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'name': name}))
    (root / 'skills' / skill / 'SKILL.md').write_text(f'---\nname: {skill}\ndescription: {skill}\n---\n')
    return str(root)
