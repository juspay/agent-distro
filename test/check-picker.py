"""Drive profile selection, harness selection, and shortcuts over a PTY."""
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

MENU = json.loads(sys.argv[1])
DEFAULT, OTHERS = MENU['default'], MENU['others']
ROWS = MENU['rows']
FIRST = ROWS[0]['title'].encode()
NAMES = [row['name'] for row in ROWS]
DOWN = b'\x1b[B'
ESCAPE = b'\x1b'
# Match displayed text independently of terminal attributes.
ANSI = re.compile(rb'\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07|[@-Z\\-_])')


def run(keys, expected, overrides=None, status=0, args=None):
    state = tempfile.TemporaryDirectory()
    pending = list(keys) if isinstance(keys, list) else ([(FIRST, keys)] if keys is not None else [])
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, AI_GATEWAY='0', TERM='xterm-256color', XDG_STATE_HOME=state.name)
        env.pop('AI_PROFILE', None)
        env.pop('AI_HARNESS', None)
        env.update(overrides or {})
        os.execvpe('ai', ['ai'] + (args if args is not None else ['--version']), env)
    # Give curses a usable terminal before it starts.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 120, 0, 0))
    output = b''
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 1)[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        if pending and pending[0][0] in ANSI.sub(b'', output):
            time.sleep(0.5)
            os.write(fd, pending.pop(0)[1])
    else:
        os.kill(pid, 9)
        raise AssertionError(output)
    _, result = os.waitpid(pid, 0)
    os.close(fd)
    drawn = ANSI.sub(b'', output)
    state.cleanup()
    assert not pending, output
    assert os.waitstatus_to_exitcode(result) == status, output
    assert expected in drawn, output
    return drawn


def flow(keys, profile_index=0):
    return ([(b'Choose a profile', DOWN * profile_index + b'\r')] if OTHERS else []) + [(FIRST, keys)]


def version(profile, harness):
    return subprocess.check_output(
        ['ai', '--version'],
        env=dict(os.environ, AI_GATEWAY='0', AI_PROFILE=profile, AI_HARNESS=harness),
        timeout=60,
    ).strip()


drawn = run(flow(b'\r'), FIRST)
for row in ROWS:
    for field in ('title', 'tagline', 'version'):
        assert row[field].encode() in drawn, drawn

for index, profile in enumerate([DEFAULT] + OTHERS):
    for row, harness in enumerate(ROWS):
        expected = version(profile, harness['name'])
        run(flow(DOWN * row + b'\r', index), expected)
        run(None, expected, args=[profile, harness['name'], '--version'])
    narrowed = run(b'\r', FIRST, {'AI_PROFILE': profile})
    assert b'Choose a profile' not in narrowed, narrowed
    narrowed = run(b'\r', FIRST, args=[profile, '--version'])
    assert b'Choose a profile' not in narrowed, narrowed

for name in NAMES:
    run(None, version(DEFAULT, name), args=[name, '--version'])

# Environment selectors win over consumed positional selectors.
run(None, version(DEFAULT, NAMES[0]), {'AI_HARNESS': NAMES[0]},
    args=[NAMES[-1], '--version'])
run(None, version(DEFAULT, NAMES[0]), {'AI_PROFILE': DEFAULT},
    args=[([DEFAULT] + OTHERS)[-1], NAMES[0], '--version'])
run(None, version(DEFAULT, NAMES[0]), {'AI_HARNESS': NAMES[0]})
run(None, ('valid values: ' + ', '.join(NAMES)).encode(), {'AI_HARNESS': 'bad'}, status=1)
run(None, b'Invalid AI_PROFILE', {'AI_PROFILE': 'nonesuch'}, status=1)

listing = subprocess.check_output(['ai', '--list']).decode().splitlines()
assert listing == [f"{profile} {row['name']} {row['title']} {row['version']}"
                   for profile in [DEFAULT] + OTHERS for row in ROWS], listing

run(flow(b'/OpenCode v2\r'), version(DEFAULT, 'opencode2'))
run(flow(b'/no-matches' + ESCAPE + b'\r'), version(DEFAULT, NAMES[0]))
run(flow(b'q'), FIRST)
if OTHERS:
    run([(b'Choose a profile', ESCAPE)], b'Choose a profile')
    run([(b'Choose a profile', b'\r'), (FIRST, b'h'),
         (b'Choose a profile', ESCAPE)], FIRST)
else:
    run(ESCAPE, FIRST)

with tempfile.TemporaryDirectory() as state:
    path = os.path.join(state, 'agent-distro', 'last-choice')
    os.makedirs(os.path.dirname(path))
    remembered = ([DEFAULT] + OTHERS)[-1] + '/' + NAMES[-1]
    with open(path, 'w') as handle:
        handle.write(remembered + '\n')
    overrides = {'XDG_STATE_HOME': state}
    drawn = run(b'\r', version(([DEFAULT] + OTHERS)[-1], NAMES[-1]), overrides)
    assert '· '.encode() in drawn, drawn
    assert b'Choose a profile' not in drawn, drawn
    assert open(path).read().strip() == remembered
    run(None, version(DEFAULT, NAMES[0]), overrides, args=[NAMES[0], '--version'])
    assert open(path).read().strip() == remembered
    run(b'k\r', version(([DEFAULT] + OTHERS)[-1], NAMES[-2]), overrides)
    assert open(path).read().strip().endswith('/' + NAMES[-2])
