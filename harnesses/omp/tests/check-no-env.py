from omp_support import *
# AGENT_DISTRO_SETTINGS=0 loads the plugins and nothing else: the wrapper's
# own display defaults stand, while the profile's roles and env never appear.
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
