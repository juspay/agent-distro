from codex_support import *

assert 'codex-cli' in run('--version', check=True).stdout
current = marketplace_root()
missing = '/nix/store/00000000000000000000000000000000-collected-marketplace'
assert not Path(missing).exists()
assert current in config.read_text()
config.write_text(config.read_text().replace(current, missing))
assert run('plugin', 'marketplace', 'list', '--json', launcher='codex-upstream').returncode != 0
assert 'codex-cli' in run('--version', check=True).stdout
assert marketplace_root() == current
assert_preserved()
