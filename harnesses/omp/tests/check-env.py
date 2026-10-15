"""The profile's `env` reaches OMP: a value as it is, a secret prompted for."""
from omp_support import *

# What the profile declares (test/lib.nix puts it in argv); it sets every
# secret in the VM's environment to "test-api-key", as a user with a key would.
profile_env = json.loads(sys.argv[3])
assert profile_env, "the gateway profile declares no env"
environ = discover()
for name, value in profile_env.items():
    wanted = (name + "=" + value) if isinstance(value, str) else (name + "=test-api-key")
    assert wanted.encode() in environ, (wanted, environ)
