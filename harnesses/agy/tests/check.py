from agy_support import *

# The launcher starts agy, which answers its version, and links the profile's
# plugins; a second launch changes nothing.
first = inventory()
assert inventory() == first

# A record that is not agent-distro's stops the launch before any change.
if first:
    saved = record.read_bytes()
    record.write_text('[]')
    result = run('--version', success=False)
    assert "not agent-distro's launch record" in result.stderr, result.stderr
    assert linked() == first
    record.write_bytes(saved)

# A home agy's directory cannot be made in: the links are skipped, not the
# launch. The cache is not what this is about, so it gets a real one.
result = run('--version', overrides={'HOME': '/homeless-shelter', 'XDG_CACHE_HOME': str(Path.home() / '.cache')})
if expected:
    assert 'cannot be written; skipping plugin links' in result.stderr, result.stderr
assert linked() == first

# No home at all still launches.
no_home = env.copy()
no_home.pop('HOME', None)
subprocess.run(['agy', '--version'], env=no_home, stdin=subprocess.DEVNULL, check=True, timeout=60)
