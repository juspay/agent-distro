"""Verify local terminal sessions start without the background server."""
import fcntl
import os
import pty
import select
import signal
import struct
import termios
import time

from codex_support import *

FAILURES = [b'Cannot use the background server', b'Experimental feature request failed',
            b'daemon executable not found', b'no complete local package']


def session(*args, seconds=15):
    """Run the launcher on a PTY; return what it drew and whether it stayed up."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(home)
        os.execvpe('codex', ['codex', *args], dict(env, TERM='xterm-256color'))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    output = b''
    # Wait for the TUI's cursor query before measuring how long it stays up.
    deadline = time.monotonic() + 90
    ready = False
    alive = True
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 1)[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b''
            if not chunk:
                alive = False
                break
            output += chunk
            # Codex asks the terminal for its colours and cursor position
            # before it draws; a terminal that never answers looks broken.
            if b'\x1b[6n' in chunk:
                if not ready:
                    ready = True
                    deadline = time.monotonic() + seconds
                os.write(fd, b'\x1b[1;1R')
    if alive:
        os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    assert not alive or ready, ('terminal did not initialize within 90s', output)
    return output, alive, os.waitstatus_to_exitcode(status)


def assert_starts(*args):
    output, alive, _ = session(*args)
    for failure in FAILURES:
        assert failure not in output, output
    assert alive, output


# A plain invocation must start without staging a package or starting a daemon.
assert_starts()
assert not (codex_home / 'packages').exists()
assert not (codex_home / 'app-server-daemon').exists()

# Existing opt-out flags remain valid (Clap rejects duplicate --no-daemon).
assert_starts('--no-daemon')

# Old daemon state must neither block startup nor be modified.
state = codex_home / 'app-server-daemon'
state.mkdir(mode=0o700)
legacy_log = state / 'app-server.stderr.log'
legacy_log.write_text('legacy daemon log sentinel\n')
assert_starts()
assert legacy_log.read_text() == 'legacy daemon log sentinel\n'
assert not (state / 'daemon.pid').exists()
assert not (codex_home / 'packages').exists()
assert_preserved()
