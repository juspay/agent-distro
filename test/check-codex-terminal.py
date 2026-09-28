"""Start a Codex session on a terminal, the one path the other checks skip.

Every other check is non-interactive, and only a session in a terminal reaches
Codex's background server, so a release that cannot start one passed them all
(#26). No login or model request: verify that the session and its pinned server stay up.
"""
import fcntl
import os
import pty
import select
import shlex
import shutil
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
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    return output, alive, os.waitstatus_to_exitcode(status)


def assert_starts(*args):
    output, alive, _ = session(*args)
    for failure in FAILURES:
        assert failure not in output, output
    assert alive, output


def server():
    result = run('app-server', 'daemon', 'version')
    assert result.returncode == 0, result.stderr
    version = json.loads(result.stdout)
    assert version['status'] == 'running', version
    assert version['appServerVersion'] == version['cliVersion'], version
    assert version['managedCodexVersion'] == version['cliVersion'], version
    assert not (codex_home / 'packages/app-server-daemon/auto-update-version').exists()
    assert not (codex_home / 'app-server-daemon/daemon-updater.pid').exists()
    return (codex_home / 'app-server-daemon/daemon.pid').read_text()


def stop():
    result = run('app-server', 'daemon', 'stop')
    assert result.returncode == 0, result.stderr


def clear_daemon():
    stop()
    for directory in ['packages', 'app-server-daemon', 'app-server-control']:
        shutil.rmtree(codex_home / directory, ignore_errors=True)


try:
    # The reported #26 state selects packages/standalone, unlike lock files.
    (codex_home / 'app-server-daemon').mkdir(mode=0o700)
    legacy_log = codex_home / 'app-server-daemon/app-server.stderr.log'
    legacy_log.write_text('legacy daemon log sentinel\n')
    assert not (codex_home / 'packages').exists()
    output, alive, exit_code = session()
    assert not alive and exit_code != 0, output
    assert b"agent-distro: files left over from an older Codex's background server" in output, output
    assert str(legacy_log).encode() in output, output
    assert b'use --no-daemon' in output, output
    assert b'daemon executable not found' not in output, output
    assert legacy_log.read_text() == 'legacy daemon log sentinel\n'
    assert not (codex_home / 'packages').exists()
    repair = next(line for line in output.decode().splitlines() if line.startswith('rm --'))
    assert shlex.split(repair) == ['rm', '--', str(legacy_log)], repair
    subprocess.run(['bash', '-c', repair], env=env, cwd=home, check=True)
    assert not legacy_log.exists()
    assert_starts()
    server()

    # Reuse the complete installed release for a real legacy standalone fixture.
    stop()
    dedicated = codex_home / 'packages/app-server-daemon'
    release = (dedicated / 'current').resolve()
    standalone = codex_home / 'packages/standalone'
    standalone.mkdir()
    shutil.copytree(release, standalone / 'release', symlinks=True)
    (standalone / 'current').symlink_to('release')
    shutil.rmtree(dedicated)
    shutil.rmtree(codex_home / 'app-server-daemon')
    (codex_home / 'app-server-daemon').mkdir(mode=0o700)
    legacy_log.write_text('working standalone log sentinel\n')
    assert_starts()
    result = run('app-server', 'daemon', 'version')
    assert result.returncode == 0, result.stderr
    version = json.loads(result.stdout)
    assert '/packages/standalone/current/' in version['managedCodexPath'], version
    assert version['status'] == 'running', version
    assert version['appServerVersion'] == version['managedCodexVersion'] == version['cliVersion'], version
    assert not (standalone / 'auto-update-version').exists()
    assert 'working standalone log sentinel' in legacy_log.read_text()
    clear_daemon()

    assert_starts()
    identity = server()
    # Steady launches must not restart a shared server's active sessions.
    assert_starts()
    assert server() == identity
    clear_daemon()

    # Help and CLI tools stay side-effect free even with flags before commands.
    for arguments in [('--version',), ('-c', 'model="my-model"', 'app-server', 'daemon', 'version')]:
        _, alive, _ = session(*arguments)
        assert not alive, arguments
        assert not (codex_home / 'packages/app-server-daemon/current').exists()

    # The flag is the user's to give; it must not install or start a server.
    assert_starts('--no-daemon')
    assert not (codex_home / 'packages/app-server-daemon/current').exists()
    assert run('app-server', 'daemon', 'version').returncode != 0
    clear_daemon()

    # Lock state left by an earlier CLI without an installed server (#26).
    for directory in ['app-server-daemon', 'app-server-control']:
        (codex_home / directory).mkdir(mode=0o700)
    for name in ['app-server-daemon/daemon.lock', 'app-server-daemon/app-server.pid.lock',
                 'app-server-control/app-server-startup.lock']:
        (codex_home / name).touch()
    assert_starts()
    server()
    assert_preserved()
finally:
    stop()
