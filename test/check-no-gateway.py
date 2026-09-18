from omp_support import *
subprocess.run(['omp', '--version'], check=True, timeout=60)
config = Path.home() / '.omp/agent/config.yml'
assert not config.exists()
environ = discover()
assert not any(v.startswith((b'LITELLM_BASE_URL=', b'OMP_SKIP_SETUP=')) for v in environ), environ
assert not config.exists()
