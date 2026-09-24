import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

DOWN = b'\x1b[B'
ESCAPE = b'\x1b'


def choose(harness, expected, overrides=None, command='ai', status=0):
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, AI_GATEWAY='0', TERM='xterm-256color')
        env.pop('AI_PROFILE', None)
        env.pop('AI_HARNESS', None)
        env.update(overrides or {})
        os.execvpe(command, [command, '--version'], env)
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
        if harness is not None and b'Choose a coding agent' in output:
            # The first frame is drawn, so gum is in its key loop.
            time.sleep(0.5)
            os.write(fd, harness)
            harness = None
    else:
        os.kill(pid, 9)
        raise AssertionError(output)
    _, result = os.waitpid(pid, 0)
    os.close(fd)
    assert os.waitstatus_to_exitcode(result) == status, output
    assert expected in output, output
    return output


choose(DOWN + b'\r', b'codex-cli')
choose(DOWN + DOWN + b'\r', b'(Claude Code)')
choose(None, b'codex-cli', {'AI_HARNESS': 'codex'})
choose(None, b'valid values: omp, codex, claude', {'AI_HARNESS': 'bad'}, status=1)
# Escape declines the menu, which is how you leave it now that there is no
# numbered prompt to type `q` at.
output = choose(ESCAPE, b'Choose a coding agent')
assert (b'uses its own login' in output) == (sys.argv[1] == 'gateway'), output
