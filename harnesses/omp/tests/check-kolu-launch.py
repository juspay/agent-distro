from omp_support import *
# Kolu's plugin from AGENT_DISTRO_PLUGINS, as kolu sets it, on a profile without it.
# As in check-kolu.py, the plugin provider's data directory is the evidence
# that OMP discovered and started kolu's MCP server.
data = Path.home() / '.omp/plugins/data'
env = dict(os.environ, AGENT_DISTRO_PLUGINS=os.environ['AGENT_DISTRO_TEST_KOLU'])
with tempfile.TemporaryDirectory() as cwd:
    try:
        subprocess.run(['omp', '--mode', 'rpc', '-p', 'hi'], cwd=cwd, env=env,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=180)
    except subprocess.TimeoutExpired:
        pass
assert any(p.name.startswith('kolu-') for p in data.iterdir())
