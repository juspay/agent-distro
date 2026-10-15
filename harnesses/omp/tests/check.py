"""A plain launch with `AGENT_DISTRO_SETTINGS=0` (harnesses/omp/meta.nix): the
plugins load and nothing else. The wrapper's own display defaults stand, and
neither the profile's environment nor its settings appear.

A guest script runs inside the VM, so the profile travels in argv (test/lib.nix).
"""
from omp_support import *

profile_env = json.loads(sys.argv[3])

subprocess.run(['omp', '--version'], check=True, timeout=60)
config = Path.home() / '.omp/agent/config.yml'
text = config.read_text()
assert 'hideThinkingBlock: true' in text, text
assert 'task:\n  showResolvedModelBadge: true' in text, text
assert 'modelRoles' not in text, text
environ = discover()
# A secret is the VM's own environment, so only the profile's plain values are
# the launcher's to leave out.
plain = [name for name, value in profile_env.items() if isinstance(value, str)]
assert not any(any(v.startswith((name + '=').encode()) for name in plain) for v in environ), environ
assert config.read_text() == text
