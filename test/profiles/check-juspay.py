"""The Juspay profile, read at launch from AI_PROFILE, as the built-in Juspay
profile behaved: its skills and Kolu's in OMP, Codex and Claude Code, its MCP
servers with mcp-nixos from the profile's packages on PATH, and OMP on its
gateway.

Usage: python check-juspay.py EXPECTED MARKETPLACE OMP_TESTS CODEX_TESTS CLAUDE_TESTS MCP_NIXOS_BIN

EXPECTED maps each plugin to its skills; the *_TESTS directories hold each
harness's support module, which reads EXPECTED (and Codex's, MARKETPLACE)
from argv as its own checks do.
"""
import json
import os
import re
import subprocess
import sys

sys.path[:0] = sys.argv[3:6]
mcp_nixos = sys.argv[6]
assert os.environ['AI_PROFILE'], 'run with AI_PROFILE set to the profile'

import omp_support  # noqa: E402
import codex_support  # noqa: E402
import claude_support  # noqa: E402

expected = omp_support.expected
skills = {skill for names in expected.values() for skill in names}

# OMP: every skill, and mcp-nixos on PATH, without the gateway as the
# built-in profile's plugin checks ran.
environ = omp_support.discover(env=dict(os.environ, AI_GATEWAY='0'), skills=skills)
path = next(v for v in environ if v.startswith(b'PATH=')).decode().removeprefix('PATH=').split(':')
assert mcp_nixos in path, path
# With the gateway: its roles, and its key required before anything starts.
env = dict(os.environ, LITELLM_API_KEY='test-api-key')
roles = json.loads(subprocess.run(['omp', 'config', 'get', 'modelRoles', '--json'], env=env, check=True,
                                  capture_output=True, text=True, timeout=120).stdout)['value']
assert roles == {'default': 'litellm/open-large', 'slow': 'litellm/open-large',
                 'smol': 'litellm/open-fast', 'task': 'litellm/open-large'}, roles
missing = subprocess.run(['omp', '--version'], env={k: v for k, v in env.items() if k != 'LITELLM_API_KEY'},
                         stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
assert missing.returncode != 0, missing
assert 'LITELLM_API_KEY is not set.' in missing.stderr and 'Requires Juspay VPN to access the dashboard' in missing.stderr, missing.stderr

# Codex: every skill under its plugin's name, and both plugins' servers.
loaded = codex_support.loaded_skills()
bundled = {name for name in loaded if ':' in name}
assert bundled == {plugin + ':' + skill for plugin, names in expected.items() for skill in names}, bundled
servers = {s['name']: s for s in json.loads(codex_support.run('mcp', 'list', '--json', check=True).stdout)}
assert {'nixos', 'kolu'} <= servers.keys(), servers
assert servers['nixos']['enabled'] and servers['kolu']['enabled'], servers
codex_support.assert_preserved()

# Claude Code: the same plugins and skills, for the session, and both
# plugins' servers, Kolu's connected.
plugins = json.loads(claude_support.run('plugin', 'list', '--json'))
assert {p['id'] for p in plugins} == {p + '@inline' for p in expected}, plugins
assert all(p['enabled'] and p['scope'] == 'session' for p in plugins), plugins
for plugin, names in expected.items():
    assert claude_support.inventory(plugin)[0] == set(names), (plugin, names)
listing = claude_support.run('mcp', 'list')
assert re.search(r'plugin:kolu:kolu: \S+ .*Connected', listing), listing
assert 'plugin:juspay-skills:nixos:' in listing, listing
print('✅ the Juspay profile at launch matches the built-in one in OMP, Codex and Claude Code')
