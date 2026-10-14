from omp_support import *
env = dict(os.environ, AGENT_DISTRO_SETTINGS='0')
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


# A plugin's stdio MCP server runs in the launch directory (doc/index.md).
if 'acme.spec-fixture' in expected:
    spec = os.environ['AGENT_DISTRO_TEST_SPEC']
    for plugins in (None, spec):
        with tempfile.TemporaryDirectory() as launch, tempfile.TemporaryDirectory() as records:
            launch = os.path.realpath(launch)
            extra = dict(os.environ, AGENT_DISTRO_SETTINGS='0', FIXTURE_RECORDS=records)
            if plugins is not None:
                extra['AGENT_DISTRO_PLUGINS'] = plugins
            # A prompt run needs a model to finish; it starts the plugin servers first.
            try:
                subprocess.run(['omp', '--mode', 'rpc', '-p', 'hi'], cwd=launch, env=extra,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=180)
            except subprocess.TimeoutExpired:
                pass
            placeholders = json.loads(Path(records, 'placeholders.json').read_text())
            assert placeholders['cwd'] == launch, placeholders
            # A plugin's own `cwd` is its author's instruction, and still wins.
            explicit = json.loads(Path(records, 'explicit-cwd.json').read_text())
            assert explicit['cwd'] == os.path.join(os.path.realpath(spec), 'share'), explicit
