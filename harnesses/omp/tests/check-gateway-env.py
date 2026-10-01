from omp_support import *
environ = discover()
assert ('LITELLM_BASE_URL=' + sys.argv[3]).encode() in environ, environ
assert b'OMP_SKIP_SETUP=1' in environ, environ
