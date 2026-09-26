"""Drive the picker's gum list over a PTY. One list, so one driver."""
import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import time

MENU = json.loads(sys.argv[1])
OTHERS = MENU['others']
DOWN = b'\x1b[B'
ESCAPE = b'\x1b'
# gum colours the cursor row, so match the text it drew, not the bytes.
ANSI = re.compile(rb'\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[=><])')


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


# The default profile's harnesses head the list, untagged, cursor on the first.
drawn = run(b'\r', b'\xe2\x9d\xaf Oh My Pi')
assert (b'(own login)' in drawn) == MENU['gateway'], drawn
run(DOWN + b'\r', b'codex-cli')
run(DOWN * 2 + b'\r', b'(Claude Code)')

# Every other profile follows, tagged with its name.
for index, name in enumerate(OTHERS):
    tagged = name.encode() + ' · Codex'.encode()
    assert tagged in drawn, drawn
    run(DOWN * (3 * (index + 1) + 1) + b'\r', b'codex-cli')

# AI_PROFILE narrows the list to one profile, which then needs no tag.
for name in OTHERS:
    narrowed = run(b'\r', b'\xe2\x9d\xaf Oh My Pi', {'AI_PROFILE': name})
    assert b' \xc2\xb7 ' not in narrowed, narrowed

# A known harness skips the list; the profile falls back to the default.
run(None, b'codex-cli', {'AI_HARNESS': 'codex'})
run(None, b'valid values: omp, codex, claude', {'AI_HARNESS': 'bad'}, status=1)
run(None, b'Invalid AI_PROFILE', {'AI_PROFILE': 'nonesuch'}, status=1)

# Escape declines the list, which is how you leave it.
run(ESCAPE, b'Oh My Pi')
