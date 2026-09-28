"""Profiles share Codex's home: launching one must not leave another's plugins (#19)."""
import json
import os
import subprocess
import sys
import tempfile

PROFILES = json.loads(sys.argv[1])


def ai(profile, *args, env):
    return subprocess.run(['ai', *args], text=True, capture_output=True, timeout=60, check=True,
                          env=dict(env, AI_PROFILE=profile, AI_HARNESS='codex'))


def registered(profile, env):
    listing = json.loads(ai(profile, 'plugin', 'marketplace', 'list', '--json', env=env).stdout)
    return {m['name'] for m in listing['marketplaces']}


for owner, has_plugins in PROFILES.items():
    if not has_plugins:
        continue
    for other in PROFILES:
        if other == owner:
            continue
        env = dict(os.environ, CODEX_HOME=tempfile.mkdtemp(), AI_GATEWAY='0')
        ai(owner, '--version', env=env)
        assert owner + '-ai' in registered(owner, env), owner
        leaked = registered(other, env) & {name + '-ai' for name in PROFILES if name != other}
        assert not leaked, f'{other} still sees {sorted(leaked)} after launching {owner}'
