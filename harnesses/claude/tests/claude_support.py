"""Read discovery from the real Claude launcher, without authentication or model calls."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

expected = json.loads(sys.argv[1])
home = Path.home()
config_dir = home / 'relocated-claude'
config_dir.mkdir()
env = dict(os.environ, CLAUDE_CONFIG_DIR=str(config_dir))
for key in ['LITELLM_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']:
    env.pop(key, None)

settings = config_dir / 'settings.json'
settings.write_text('{"model":"sonnet","env":{"PERSONAL_SETTING":"keep"}}\n')
credentials = config_dir / '.credentials.json'
credentials.write_text('{}\n')
session = config_dir / 'projects' / 'keep.jsonl'
session.parent.mkdir()
session.write_text('session sentinel\n')
preserved = {path: path.read_bytes() for path in [settings, credentials, session]}


def run(*args, launcher='claude', plugins=None):
    # `plugins` is AGENT_DISTRO_PLUGINS for this launch only.
    extra = {} if plugins is None else {'AGENT_DISTRO_PLUGINS': plugins}
    return subprocess.run([launcher, *args], env=env | extra, text=True,
                          capture_output=True, timeout=60, check=True).stdout


def inventory(plugin, launcher='claude', plugins=None):
    # Claude's own inventory, rather than inspecting the translated files.
    details = run('plugin', 'details', plugin, launcher=launcher, plugins=plugins)
    # An MCP-only plugin prints `Skills (0)` with no names after it.
    match = re.search(r'^\s*Skills \((\d+)\)[ \t]*([^\n]*)', details, re.MULTILINE)
    assert match, details
    names = set(filter(None, match[2].split(', ')))
    assert len(names) == int(match[1]), details
    return names, details


def checkout(name, skill):
    """A plugin working copy outside the store, as a user edits one."""
    root = home / 'checkouts' / name
    (root / 'skills' / skill).mkdir(parents=True)
    (root / 'plugin.json').write_text(json.dumps({
        '$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'name': name}))
    (root / 'skills' / skill / 'SKILL.md').write_text(f'---\nname: {skill}\ndescription: {skill}\n---\n')
    return str(root)
