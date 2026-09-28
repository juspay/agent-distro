"""Start a Codex session on a terminal, the one path the other checks skip.

Every other check is non-interactive, and only a session in a terminal reaches
Codex's background server, so a release that cannot start one passed them all
(#26). No login and no network: a session that stays up is the whole claim.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import termios
import time

from codex_support import *

FAILURES = [b'--no-daemon', b'daemon executable not found', b'no complete local package']


def session(*args, seconds=15):
    """Run the launcher on a PTY; return what it drew and whether it stayed up."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(home)
        os.execvpe('codex', ['codex', *args], dict(env, TERM='xterm-256color'))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    output = b''
    deadline = time.monotonic() + seconds
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
                os.write(fd, b'\x1b[1;1R')
    if alive:
        os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    os.close(fd)
    return output, alive


def assert_starts(*args):
    output, alive = session(*args)
    for failure in FAILURES:
        assert failure not in output, output
    assert alive, output


assert_starts()
# The flag is the user's to give as well; Codex rejects it given twice.
assert_starts('--no-daemon')

# A home an earlier Codex left its background server's state in, without the
# install that server needs: the state #26 was reported from.
for directory in ['app-server-daemon', 'app-server-control']:
    (codex_home / directory).mkdir(mode=0o700)
for name in ['app-server-daemon/daemon.lock', 'app-server-daemon/app-server.pid.lock',
             'app-server-control/app-server-startup.lock']:
    (codex_home / name).touch()
assert_starts()

assert_preserved()
