from omp_support import *
env = dict(os.environ, AI_GATEWAY='0')
config = Path.home() / '.omp/agent/config.yml'
config.parent.mkdir(parents=True, exist_ok=True)
# Explicit values, including a display default the user turned off, must stop
# a steady-state launch from rewriting the file.
config.write_text('# personal provider\nmodelRoles:\n  default: openai/my-model\nhideThinkingBlock: false\n')
before = config.read_bytes(), config.stat().st_ino, config.stat().st_mtime_ns
discover(env=env)
discover('omp-updated', env=env)
assert (config.read_bytes(), config.stat().st_ino, config.stat().st_mtime_ns) == before
