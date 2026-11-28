from agy_support import *

# The launcher starts agy, which answers its version, and links the profile's
# plugins; a second launch changes nothing.
first = inventory()
assert inventory() == first

# A plugin a running launch still uses stays, whatever later launches want:
# here a process stands in for that launch's agy, claiming the fixture's entry.
fixture = os.environ['AGENT_DISTRO_TEST_PLUGIN']
placed = inventory(value=fixture, wanted=set(expected) | {'launch-fixture'}, skills={**expected, 'launch-fixture': ['launched']})
stand_in = subprocess.Popen(['sleep', '600'])
stat = Path(f'/proc/{stand_in.pid}/stat').read_text()
(claims / f'{stand_in.pid}.json').write_text(json.dumps({
    'pid': stand_in.pid, 'identity': stat[stat.rindex(')') + 2:].split(' ')[19],
    'directory': str(plugins), 'links': {'launch-fixture': placed['launch-fixture']}}))
run('--version')
assert linked().get('launch-fixture') == placed['launch-fixture'], linked()
stand_in.kill()
stand_in.wait()
assert inventory() == first

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
