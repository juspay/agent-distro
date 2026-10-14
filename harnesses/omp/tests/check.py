from omp_support import *

# The profile this launcher was built with declares nothing: the opt-out check
# is the only one that applies.
if profile_env:
    subprocess.run(['omp', '--version'], check=True, timeout=60)
    discover()
else:
    exec(Path(__file__).with_name('check-no-env.py').read_text())
