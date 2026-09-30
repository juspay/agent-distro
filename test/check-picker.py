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
        if pending is not None and b'Oh My Pi' in ANSI.sub(b'', output):
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


drawn = run(b'\r', b'Oh My Pi')

if OTHERS:
    # The whole registry: no header, and every row names its profile in a
    # column of its own.
    assert not re.search(rb'[A-Za-z]', heading(drawn)), drawn
    assert re.search(re.escape(DEFAULT.encode()) + rb' +Oh My Pi', drawn), drawn
else:
    # One profile: its description heads the list and the rows need no tag.
    assert re.search(rb'[A-Za-z]', heading(drawn)), drawn
    assert drawn.startswith(heading(drawn) + CURSOR + b'Oh My Pi'), drawn

run(DOWN + b'\r', b'codex-cli')
run(DOWN * 2 + b'\r', b'(Claude Code)')
opencode_version = subprocess.check_output(
    ['ai', '--version'],
    env=dict(os.environ, AI_GATEWAY='0', AI_PROFILE=DEFAULT, AI_HARNESS='opencode'),
    timeout=60,
).strip()
run(DOWN * 3 + b'\r', opencode_version)

for index, name in enumerate(OTHERS):
    assert re.search(re.escape(name.encode()) + rb' +Codex', drawn), drawn
    run(DOWN * (4 * (index + 1) + 1) + b'\r', b'codex-cli')

# AI_PROFILE narrows the list to one profile, which then needs no tag and gets
# its description back as the header.
for name in [DEFAULT] + OTHERS:
    narrowed = run(b'\r', b'Oh My Pi', {'AI_PROFILE': name})
    assert re.search(rb'[A-Za-z]', heading(narrowed)), narrowed
    assert narrowed.startswith(heading(narrowed) + CURSOR + b'Oh My Pi'), narrowed

# A known harness skips the list; the profile falls back to the default.
run(None, b'codex-cli', {'AI_HARNESS': 'codex'})
run(None, b'valid values: omp, codex, claude, opencode', {'AI_HARNESS': 'bad'}, status=1)
run(None, b'Invalid AI_PROFILE', {'AI_PROFILE': 'nonesuch'}, status=1)

# Escape declines the list, which is how you leave it.
run(ESCAPE, b'Oh My Pi')
