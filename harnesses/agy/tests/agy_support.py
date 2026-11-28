"""What the real agy launcher leaves where agy reads plugins, without an account.

No VM can sign in, so nothing here asks agy to load a plugin: these read the
folders the launcher links into `~/.gemini/config/plugins/`, start their MCP
servers through the commands agy would, and run agy only for `--version`.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

SCHEMA = 'https://antigravity.google/schemas/v1/plugin.json'

expected = json.loads(sys.argv[1])
config = Path.home() / '.gemini/config'
plugins = config / 'plugins'
record = config / '.agent-distro-launch.json'
env = dict(os.environ)

# A plugin of the user's own, which no launch may touch.
mine = plugins / 'mine'
mine.mkdir(parents=True, exist_ok=True)
(mine / 'plugin.json').write_text('{"name": "mine"}\n')


def run(*args, launcher='agy', overrides=None, success=True):
    result = subprocess.run([launcher, *args], env=env | (overrides or {}), stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=120)
    assert (result.returncode == 0) == success, (result.stdout, result.stderr)
    return result


def with_plugins(value):
    """AGENT_DISTRO_PLUGINS for one launch only."""
    return {} if value is None else {'AGENT_DISTRO_PLUGINS': value}


def linked():
    """Plugin name → the translation linked under it; the user's folder is still theirs."""
    assert (mine / 'plugin.json').read_text() == '{"name": "mine"}\n'
    entries = {entry.name: os.readlink(entry) for entry in plugins.iterdir() if entry.is_symlink()}
    assert {entry.name for entry in plugins.iterdir()} == {'mine', *entries}, list(plugins.iterdir())
    return entries


def servers(name):
    """The MCP servers agy reads from one linked plugin."""
    path = plugins / name / 'mcp_config.json'
    return json.loads(path.read_text())['mcpServers'] if path.exists() else {}


def inventory(launcher='agy', value=None, wanted=None, skills=None):
    """Launch once, and check every plugin it should have linked is there as agy reads it."""
    assert run('--version', launcher=launcher, overrides=with_plugins(value)).stdout.strip()
    skills = expected if skills is None else skills
    links = linked()
    names = set(expected) if wanted is None else wanted
    assert set(links) == names, (links, names)
    if links:
        assert json.loads(record.read_text()) == {'links': links}
    else:
        assert not record.exists()
    for name in links:
        manifest = json.loads((plugins / name / 'plugin.json').read_text())
        assert manifest['$schema'] == SCHEMA and manifest['name'] == name, manifest
        for skill in skills.get(name, []):
            assert (plugins / name / 'skills' / skill / 'SKILL.md').is_file(), (name, skill)
    return links


def initialize(command):
    """Start an MCP server the way agy starts one, and return what it says it is."""
    request = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
        'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'check', 'version': '0'}}}
    result = subprocess.run([command], input=json.dumps(request) + '\n', env=env,
                            capture_output=True, text=True, timeout=60)
    response = json.loads(result.stdout.splitlines()[0])
    return response['result']['serverInfo']


def checkout(name, skill):
    """A plugin working copy outside the store, as a user edits one."""
    root = Path.home() / 'checkouts' / name
    (root / 'skills' / skill).mkdir(parents=True)
    (root / 'plugin.json').write_text(json.dumps({
        '$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'name': name}))
    (root / 'skills' / skill / 'SKILL.md').write_text(f'---\nname: {skill}\ndescription: {skill}\n---\n')
    return str(root)
