from pi_support import *

inventory()
discover()
# Stale generated paths disappear; personal skill paths remain.
personal = Path.home() / 'personal-skills'
personal.mkdir()
resolved = json.loads(settings.read_text())
resolved['skills'] += [str(personal), '/nix/store/old-pi-config/skills/stale']
settings.write_text(json.dumps(resolved))
resolved, _ = inventory()
assert str(personal) in resolved['skills']
assert not any('/old-pi-config/' in path for path in resolved['skills'])

# Invalid JSON in either file aborts before any merge writes another file.
for target in [settings, mcp]:
    original = target.read_bytes()
    for invalid in ['{', '[]', 'null']:
        target.write_text(invalid)
        before = {p: p.read_bytes() for p in [settings, mcp]}
        run('--version', success=False)
        assert all(p.read_bytes() == value for p, value in before.items())
    target.write_bytes(original)

with tempfile.TemporaryDirectory() as directory:
    relocated = Path(directory)
    run('--version', overrides={'PI_CODING_AGENT_DIR': directory})
    servers = json.loads((relocated / 'mcp.json').read_text())['mcpServers'] if (relocated / 'mcp.json').exists() else {}
    assert servers == {
        name: server for name, server in json.loads(mcp.read_text())['mcpServers'].items()
        if name != 'personal'}
    if not expected:
        assert not (relocated / 'mcp.json').exists()
        # An empty profile still gets the thinking-block default.
        assert json.loads((relocated / 'settings.json').read_text()) == {'hideThinkingBlock': True}
    relocated.chmod(0o500)
    try:
        run('--version', overrides={'PI_CODING_AGENT_DIR': directory})
    finally:
        relocated.chmod(0o700)

no_home = env.copy()
no_home.pop('HOME', None)
no_home.pop('PI_CODING_AGENT_DIR', None)
subprocess.run(['pi', '--version'], env=no_home, check=True, timeout=60)
run('--version', overrides={'HOME': '/homeless-shelter', 'PI_CODING_AGENT_DIR': ''})
