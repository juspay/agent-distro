from omp_support import *
subprocess.run(['omp', '--version'], check=True, timeout=60)
config = Path.home() / '.omp/agent/config.yml'
# The non-gateway profile still hides thinking blocks: the display default is
# independent of the gateway, while its roles and badge never appear.
text = config.read_text()
assert 'hideThinkingBlock: true' in text, text
assert 'modelRoles' not in text, text
environ = discover()
assert not any(v.startswith((b'LITELLM_BASE_URL=', b'OMP_SKIP_SETUP=')) for v in environ), environ
assert config.read_text() == text
