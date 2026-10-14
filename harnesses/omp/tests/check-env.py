"""The profile's `env` reaches OMP: a value as it is, a secret prompted for."""
from omp_support import *

# `profile_env` is what the profile declares; lib.nix sets every secret in the
# VM's environment to "test-api-key", as a user who has a key would.
assert profile_env, "the gateway profile declares no env"
environ = discover()
for name, value in profile_env.items():
    wanted = (name + "=" + value) if isinstance(value, str) else (name + "=test-api-key")
    assert wanted.encode() in environ, (wanted, environ)
