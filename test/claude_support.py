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


def run(*args, launcher='claude'):
    return subprocess.run([launcher, *args], env=env, text=True,
                          capture_output=True, timeout=60, check=True).stdout


def inventory(plugin, launcher='claude'):
    # Claude's own inventory, rather than inspecting the translated files.
    details = run('plugin', 'details', plugin, launcher=launcher)
    match = re.search(r'^\s*Skills \((\d+)\)\s+([^\n]+)', details, re.MULTILINE)
    assert match, details
    names = set(match[2].split(', '))
    assert len(names) == int(match[1]), details
    return names, details
