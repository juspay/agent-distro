from omp_support import *
env = dict(os.environ, AI_GATEWAY='0')
config = Path.home() / '.omp/agent/config.yml'
config.parent.mkdir(parents=True, exist_ok=True)
config.write_text('# personal provider\nmodelRoles:\n  default: openai/my-model\n')
before = config.read_bytes(), config.stat().st_ino, config.stat().st_mtime_ns
discover(env=env)
discover('omp-updated', env=env)
assert (config.read_bytes(), config.stat().st_ino, config.stat().st_mtime_ns) == before
