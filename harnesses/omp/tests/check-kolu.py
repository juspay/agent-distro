from omp_support import *
# MCP discovery runs before the offline model request fails. ACP clients own
# their own servers, so use the plugin provider's data directory as evidence.
with tempfile.TemporaryDirectory() as cwd:
    try:
        subprocess.run(['omp', '--mode', 'rpc', '-p', 'hi'], cwd=cwd,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=180)
    except subprocess.TimeoutExpired:
        pass
assert any(p.name.startswith('kolu-') for p in (Path.home() / '.omp/plugins/data').iterdir())
