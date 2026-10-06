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

# AGENT_DISTRO_PLUGINS: the store fixture joins as one more -e root, for that launch.
fixture = os.environ['AGENT_DISTRO_TEST_PLUGIN']
discover(env=dict(env, AGENT_DISTRO_PLUGINS=fixture), skills=expected_skills | {'launched'})
# A checkout named like a profile plugin replaces it.
name = next(iter(expected))
others = {skill for plugin, skills in expected.items() if plugin != name for skill in skills}
discover(env=dict(env, AGENT_DISTRO_PLUGINS=checkout(name, 'shadowed')), skills=others | {'shadowed'})
discover(env=env)
assert (config.read_bytes(), config.stat().st_ino, config.stat().st_mtime_ns) == before
