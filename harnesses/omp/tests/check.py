from omp_support import *

if sys.argv[3]:
    subprocess.run(['omp', '--version'], check=True, timeout=60)
    discover()
else:
    exec(Path(__file__).with_name('check-no-gateway.py').read_text())
