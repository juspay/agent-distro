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

# A broken unrelated registration must not prevent our first registration.
upstream('plugin', 'marketplace', 'remove', marketplace)
config.write_text(config.read_text() + f'\n[marketplaces.unrelated]\nsource = "{missing}"\n')
assert run('plugin', 'marketplace', 'list', '--json', launcher='codex-upstream').returncode != 0
assert 'codex-cli' in run('--version', check=True).stdout
settings = tomllib.loads(config.read_text())
assert settings['marketplaces'][marketplace]['source'] == current
assert settings['marketplaces']['unrelated']['source'] == missing
assert_preserved()
upstream('plugin', 'marketplace', 'remove', 'unrelated')
assert marketplace_root() == current
