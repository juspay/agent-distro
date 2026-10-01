"""Drive the picker's gum list over a PTY. One list, so one driver."""
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

MENU = json.loads(sys.argv[1])
DEFAULT, OTHERS = MENU['default'], MENU['others']
ROWS = MENU['rows']
FIRST = ROWS[0]['title'].encode()
NAMES = [row['name'] for row in ROWS]
DOWN = b'\x1b[B'
ESCAPE = b'\x1b'
CURSOR = '❯ '.encode()
# gum colours the cursor row and negotiates terminal features, so match the
# text it drew rather than the bytes it drew it with.
ANSI = re.compile(rb'\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07|[@-Z\\-_])')


def run(keys, expected, overrides=None, status=0):
    pending = keys
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, AI_GATEWAY='0', TERM='xterm-256color')
        env.pop('AI_PROFILE', None)
        env.pop('AI_HARNESS', None)
        env.update(overrides or {})
        os.execvpe('ai', ['ai', '--version'], env)
    # pty.fork leaves the terminal zero-sized, and gum draws nothing into a
    # window with no rows: give it one before it starts.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
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
        if pending is not None and FIRST in ANSI.sub(b'', output):
            # The first frame is drawn, so gum is in its key loop.
            time.sleep(0.5)
            os.write(fd, pending)
            pending = None
    else:
        os.kill(pid, 9)
        raise AssertionError(output)
    _, result = os.waitpid(pid, 0)
    os.close(fd)
    drawn = ANSI.sub(b'', output)
    assert pending is None, output
    assert os.waitstatus_to_exitcode(result) == status, output
    assert expected in drawn, output
    return drawn


def heading(drawn):
    """Whatever the list drew above its first row."""
    return drawn.split(CURSOR)[0]


drawn = run(b'\r', FIRST)

if OTHERS:
    # The whole registry: no header, and every row names its profile in a
    # column of its own.
    assert not re.search(rb'[A-Za-z]', heading(drawn)), drawn
    assert re.search(re.escape(DEFAULT.encode()) + rb' +' + re.escape(FIRST), drawn), drawn
else:
    # One profile: its description heads the list and the rows need no tag.
    assert re.search(rb'[A-Za-z]', heading(drawn)), drawn
    assert drawn.startswith(heading(drawn) + CURSOR + FIRST), drawn

for index, profile in enumerate([DEFAULT] + OTHERS):
    for row, harness in enumerate(ROWS):
        version = subprocess.check_output(
            ['ai', '--version'],
            env=dict(os.environ, AI_GATEWAY='0', AI_PROFILE=profile, AI_HARNESS=harness['name']),
            timeout=60,
        ).strip()
        run(DOWN * (len(ROWS) * index + row) + b'\r', version)

# AI_PROFILE narrows the list to one profile, which then needs no tag and gets
# its description back as the header.
for name in [DEFAULT] + OTHERS:
    narrowed = run(b'\r', FIRST, {'AI_PROFILE': name})
    assert re.search(rb'[A-Za-z]', heading(narrowed)), narrowed
    assert narrowed.startswith(heading(narrowed) + CURSOR + FIRST), narrowed

# A known harness skips the list; the profile falls back to the default.
run(None, subprocess.check_output(['ai', '--version'], env=dict(os.environ, AI_GATEWAY='0', AI_HARNESS=NAMES[0])).strip(), {'AI_HARNESS': NAMES[0]})
run(None, ('valid values: ' + ', '.join(NAMES)).encode(), {'AI_HARNESS': 'bad'}, status=1)
run(None, b'Invalid AI_PROFILE', {'AI_PROFILE': 'nonesuch'}, status=1)

# Escape declines the list, which is how you leave it.
run(ESCAPE, FIRST)
