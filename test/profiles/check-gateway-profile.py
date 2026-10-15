"""The gateway profile of test/flake.nix, read at launch from AI_PROFILE, as a
built-in one would behave: its skills and Kolu's in OMP, Codex and Claude Code,
its MCP servers with mcp-nixos from the profile's packages on PATH, and OMP
with the environment and model roles it declares.

Usage: python check-gateway-profile.py EXPECTED MARKETPLACE OMP_TESTS CODEX_TESTS CLAUDE_TESTS MCP_NIXOS_BIN PROFILE_ENV PROFILE_SETTINGS

EXPECTED maps each plugin to its skills; the *_TESTS directories hold each
harness's support module, which reads EXPECTED (and Codex's, MARKETPLACE) from
argv as its own checks do. PROFILE_ENV and PROFILE_SETTINGS are the profile's
own, so the assertions and the profile cannot drift apart.
"""
import json
import os
import re
import subprocess
import sys

sys.path[:0] = sys.argv[3:6]
mcp_nixos = sys.argv[6]
profile_env = json.loads(sys.argv[7])
profile_settings = json.loads(sys.argv[8])
assert os.environ['AI_PROFILE'], 'run with AI_PROFILE set to the profile'

import omp_support  # noqa: E402
import codex_support  # noqa: E402
import claude_support  # noqa: E402

expected = omp_support.expected
skills = {skill for names in expected.values() for skill in names}
secrets = [name for name, value in profile_env.items() if not isinstance(value, str)]
assert len(secrets) == 1, profile_env
key = secrets[0]

# OMP, without the profile's environment: every skill, and mcp-nixos on PATH.
environ = omp_support.discover(env=dict(os.environ, AGENT_DISTRO_SETTINGS='0'), skills=skills)
path = next(v for v in environ if v.startswith(b'PATH=')).decode().removeprefix('PATH=').split(':')
assert mcp_nixos in path, path
# With it: the profile's roles in the config, and its key required before
# anything starts. The key is the check's to provide — the VM has none — as a
# user who has one would.
plain = {name: value for name, value in profile_env.items() if isinstance(value, str)}
env = dict(os.environ, **plain, **{key: 'test-api-key'})
roles = json.loads(subprocess.run(['omp', 'config', 'get', 'modelRoles', '--json'], env=env, check=True,
                                  capture_output=True, text=True, timeout=120).stdout)['value']
assert roles == profile_settings['omp']['modelRoles'], roles
missing = subprocess.run(['omp', '--version'], env={k: v for k, v in env.items() if k != key},
                         stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
assert missing.returncode != 0, missing
assert f'cannot prompt for {key} (stdin is not a terminal)' in missing.stderr, missing.stderr
assert profile_env[key]['hint'] in missing.stderr, missing.stderr

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
print('✅ the gateway profile at launch matches a built-in one in OMP, Codex and Claude Code')
