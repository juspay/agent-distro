from agy_support import *

# Kolu's plugin from AGENT_DISTRO_PLUGINS, as kolu sets it, on a profile without it.
kolu = os.environ['AGENT_DISTRO_TEST_KOLU']
assert 'kolu' in inventory(value=kolu, wanted=set(expected) | {'kolu'})
assert initialize(servers('kolu')['kolu']['command'])['name'] == 'kolu-test'
# Unset, the next launch takes it back.
assert 'kolu' not in inventory()
assert not (plugins / 'kolu').exists()
