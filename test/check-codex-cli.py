"""Keep the terminal classifier tied to Codex help and exercise failure messages."""
import fcntl
import pty
import re
import select
import struct
import tempfile
import termios
import time

from codex_support import *


def check_contract():
    prelude = Path(os.environ['CODEX_DAEMON_PRELUDE']).read_text()
    help_result = run('--help')
    assert help_result.returncode == 0, help_result.stderr
    help_text = help_result.stdout
    commands_text = help_text.split('Commands:\n', 1)[1].split('Options:', 1)[0]
    commands = set(re.findall(r'^  ([a-z][a-z-]+)\s', commands_text, re.M))
    aliases = set()
    for group in re.findall(r'\[aliases: ([^]]+)\]', commands_text):
        aliases.update(group.split(', '))
    tools = set(re.search(r'^\s+(exec\|e\|[^\n]+)\)\n', prelude, re.M)[1].split('|'))
    # Hidden commands/aliases cannot be checked against public help. `app` is macOS-only.
    hidden = {'tcp-tunnel', 'execpolicy', 'responses-api-proxy', 'stdio-to-uds', 'cloud-tasks'}
    platform_only = {'app'} if sys.platform != 'darwin' else set()
    interactive = {'agents', 'resume', 'fork'}
    assert commands | aliases == (tools - hidden - platform_only) | interactive, (
        'Codex command grammar drift', commands | aliases, tools)

    values = set()
    for line in help_text.splitlines():
        if re.match(r'^\s+(?:-[A-Za-z], )?--[\w-]+\s+<', line):
            values.update(re.findall(r'(?<!\w)--?[A-Za-z][\w-]*', line.split('<', 1)[0]))
    value_pattern = re.search(r'^\s+(--config\|-c\|[^\n]+)\)\n', prelude, re.M)[1]
    # --remote takes a value but bypasses the local-server prelude altogether.
    assert values == set(value_pattern.split('|')) | {'--remote'}, (
        'Codex value-flag grammar drift', values, value_pattern)

    # Probe the pinned binary's package selection below instead of gating every
    # release on a source review. Terminal checks cover real startup and pinning.
    legacy_names = re.search(r'legacy_artifacts=\(([^)]+)\)', prelude)[1].split()
    assert legacy_names == ['app-server.pid', 'app-server.stderr.log',
                            'app-server-updater.pid', 'app-server-updater.stderr.log']

    dedicated_names = re.search(r'dedicated_artifacts=\(([^)]+)\)', prelude)[1].split()
    assert dedicated_names == ['daemon.pid', 'daemon.stderr.log',
                               'daemon-updater.pid', 'daemon-updater.stderr.log']
    return legacy_names, dedicated_names


def check_package_selection(legacy_names, dedicated_names):
    def check(artifacts=(), *, dangling=False, current=None, layout=None,
              expected='app-server-daemon/current/bin/codex'):
        # A separate, never-started home makes `stop` a cheap package-selection
        # query: its JSON reports managedCodexPath without staging a release or
        # starting a server. Empty PID files cannot refer to a running process.
        with tempfile.TemporaryDirectory(dir=home, prefix='daemon-contract-') as directory:
            root = Path(directory)
            state = root / 'app-server-daemon'
            state.mkdir()
            for name in artifacts:
                artifact = state / name
                if dangling:
                    artifact.symlink_to('missing-artifact')
                else:
                    artifact.touch()
            if current:
                path = root / 'packages/app-server-daemon/current'
                path.parent.mkdir(parents=True)
                if current == 'symlink':
                    path.symlink_to('missing-release')
                else:
                    path.mkdir()
            if layout:
                binary = root / 'packages/standalone/current' / layout
                binary.parent.mkdir(parents=True)
                binary.touch()
            result = subprocess.run(
                ['codex', 'app-server', 'daemon', 'stop'],
                env=dict(env, CODEX_HOME=directory), text=True,
                capture_output=True, timeout=15)
            assert result.returncode == 0, (artifacts, result.stderr)
            selected = json.loads(result.stdout)['managedCodexPath']
            assert selected == str(root / 'packages' / expected), (
                'Codex daemon package-selection drift', artifacts, dangling,
                current, layout, selected, expected)

    check()
    for dangling in [False, True]:
        for name in legacy_names:
            check([name], dangling=dangling, expected='standalone/current/codex')
        for name in dedicated_names:
            # Dedicated artifacts must override otherwise-selected legacy state.
            check(['app-server.stderr.log', name], dangling=dangling)
    for current in ['directory', 'symlink']:
        check(legacy_names, current=current)
    for layout in ['codex', 'bin/codex']:
        check(['app-server.stderr.log'], layout=layout,
              expected='standalone/current/' + layout)


legacy_names, dedicated_names = check_contract()
check_package_selection(legacy_names, dedicated_names)
fixture = codex_home / 'fixture-codex'
fixture.write_text('#!' + sys.executable + '\n' + r'''
import json, os, pathlib, sys
home = pathlib.Path(os.environ['CODEX_HOME'])
case = os.environ['CODEX_FAILURE_CASE']
command = sys.argv[3]
with (home/'fixture-calls').open('a') as calls:
    calls.write(command+'\n')
if (command, case) in [('start','start'), ('update','update'), ('version','version')]:
    print('fixture command failed', file=sys.stderr)
    sys.exit(1)
if case == 'json':
    print('not JSON')
    sys.exit(0)
state = dict(status='running', backend='pid',
             managedCodexPath=str(home/'packages/app-server-daemon/current/bin/codex'),
             managedCodexVersion='1.2.3', appServerVersion='1.2.3')
if case == 'unmanaged':
    state['backend'] = None
if case == 'path':
    state['managedCodexPath'] = '/unexpected/codex'
if case == 'missing-path':
    del state['managedCodexPath']
if command == 'start' and case == 'update':
    state['managedCodexVersion'] = '0.0.0'
if command == 'version' and case == 'mismatch':
    state['appServerVersion'] = '0.0.0'
print(json.dumps(state))
''')
fixture.chmod(0o700)
marker = codex_home / 'packages/app-server-daemon/auto-update-version'
marker.parent.mkdir(parents=True)


def check_case(case, message=None):
    (codex_home / 'fixture-calls').write_text('')
    if case == 'marker':
        marker.write_text('fixture')
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(home)
        os.execvpe('bash', ['bash', '-euo', 'pipefail', '-c',
                           'source "$CODEX_DAEMON_PRELUDE"; echo LAUNCHED'],
                   dict(env, codex=str(fixture), codex_version='1.2.3',
                        CODEX_FAILURE_CASE=case, TERM='xterm-256color'))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    output = b''
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if select.select([fd], [], [], 1)[0]:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
        else:
            raise AssertionError(('fixture timed out', case, output))
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        _, status = os.waitpid(pid, 0)
        os.close(fd)
        marker.unlink(missing_ok=True)
    if message is None:
        assert os.waitstatus_to_exitcode(status) == 0, (case, output)
        assert b'LAUNCHED' in output and b'agent-distro:' not in output, output
        assert (codex_home / 'fixture-calls').read_text() == 'start\nversion\n'
        return
    assert os.waitstatus_to_exitcode(status) != 0, (case, output)
    assert b'LAUNCHED' not in output, (case, output)
    assert b'agent-distro: ' in output and message.encode() in output, (case, output)
    assert b'use --no-daemon to start a session without the background server' in output, (case, output)
    if case == 'legacy':
        assert (codex_home / 'fixture-calls').read_text() == ''
    if case == 'unmanaged':
        assert (codex_home / 'fixture-calls').read_text() == 'start\n'


for case, message in [
    ('start', 'startup failed'),
    ('json', 'startup response'),
    ('unmanaged', 'leaving it running unchanged'),
    ('path', 'unexpected package path'),
    ('missing-path', 'package path from Codex'),
    ('update', 'package replacement failed'),
    ('version', 'version query failed'),
    ('marker', 'automatic-update marker is still present'),
    ('mismatch', 'running and installed versions'),
]:
    check_case(case, message)
# Each source-defined artifact independently blocks before any Codex command,
# including dangling symlinks (the upstream selector uses symlink_metadata).
state = codex_home / 'app-server-daemon'
state.mkdir()
for name in legacy_names:
    artifact = state / name
    artifact.write_text('legacy sentinel')
    check_case('legacy', str(artifact))
    assert artifact.read_text() == 'legacy sentinel'
    artifact.unlink()
artifact.symlink_to('missing-target')
check_case('legacy', str(artifact))
assert artifact.is_symlink()
artifact.unlink()
# Dedicated selection takes precedence over leftover legacy state.
artifact.write_text('legacy sentinel')
current = marker.parent / 'current'
current.mkdir()
check_case('dedicated-current')
current.rmdir()
current.symlink_to('missing-target')
check_case('dedicated-current-symlink')
current.unlink()
for name in dedicated_names:
    dedicated = state / name
    dedicated.touch()
    check_case('dedicated-artifact')
    dedicated.unlink()
assert artifact.read_text() == 'legacy sentinel'
artifact.unlink()
assert_preserved()
