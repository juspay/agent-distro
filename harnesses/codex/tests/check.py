from codex_support import *

assert 'codex-cli' in run('--version', check=True).stdout
before = config.read_bytes()
assert_skills()
assert {p['pluginId'] for p in json.loads(run('plugin', 'list', '--json', check=True).stdout)['installed']} == {p + '@' + marketplace for p in expected}
assert config.read_bytes() == before
assert_preserved()
assert run('not-a-subcommand').returncode != 0
invalid = 'model = [\n'
config.write_text(invalid)
assert run('mcp', 'list', '--json').returncode != 0
assert config.read_text() == invalid
