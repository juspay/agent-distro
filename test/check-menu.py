"""Drive the profile menu, which chains straight into a harness picker."""
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

DEFAULT, OTHER = sys.argv[1], sys.argv[2]
DOWN = b'\x1b[B'
ESCAPE = b'\x1b'
PROFILE_MENU = b'Choose a profile:'
HARNESS_MENU = b'Choose a coding agent'


def run(replies, expected, overrides=None, status=0):
    """Answer each menu as it appears; `replies` maps a header to its keys."""
    pending = dict(replies)
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
    deadline = time.monotonic() + 120
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
        for header, keys in list(pending.items()):
            if header in output:
                # The first frame is drawn, so gum is in its key loop.
                time.sleep(0.5)
                os.write(fd, keys)
                del pending[header]
                break
    else:
        os.kill(pid, 9)
        raise AssertionError(output)
    _, result = os.waitpid(pid, 0)
    os.close(fd)
    assert os.waitstatus_to_exitcode(result) == status, output
    assert expected in output, output
    assert not pending, output
    return output


# The registry's default starts under the cursor, so Enter takes it and the
# harness picker then runs with that profile's launchers.
output = run({PROFILE_MENU: b'\r', HARNESS_MENU: DOWN + b'\r'}, b'codex-cli')
assert b'> ' + DEFAULT.encode() in output, output

# A named profile skips its menu and lands straight on the harness picker.
run({HARNESS_MENU: DOWN + DOWN + b'\r'}, b'(Claude Code)', {'AI_PROFILE': OTHER})

# Escape declines the profile menu, which is how you leave it.
run({PROFILE_MENU: ESCAPE}, PROFILE_MENU)
