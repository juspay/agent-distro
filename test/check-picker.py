"""Drive the picker over a PTY: the profile in effect, filter, shortcuts, fallback and `--list`."""
import base64
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import termios
import time

LISTING = json.loads(sys.argv[1])
# The launcher's one built-in profile, in effect when nothing chooses another.
[BUILTIN] = LISTING['profiles']
DEFAULT = BUILTIN['name']
ROWS = BUILTIN['harnesses']
NAMES = [row['name'] for row in ROWS]
DOWN = b'\x1b[B'
RIGHT = b'\x1b[C'
ESCAPE = b'\x1b'
# The footer names what Enter does, and is there from the first frame.
LAUNCH = b'Enter launch'
# The numbered list's prompt.
PLAIN_PROMPT = b'Launch ['
TOO_SMALL = b'Terminal too small'
# Match displayed text independently of terminal attributes.
ANSI = re.compile(rb'\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07|[()][0-~]|[@-Z\\-_])')
SGR = re.compile(rb'\x1b\[([0-9;]*)m')


def colours(raw):
    """SGR parameters that set a colour rather than an attribute."""
    return [p for match in SGR.findall(raw) for p in match.split(b';')
            if p and (30 <= int(p) <= 49 or 90 <= int(p) <= 107)]


class Run:
    def __init__(self, raw, choice, lflag):
        self.raw = raw
        self.drawn = ANSI.sub(b'', raw)
        self.choice = choice
        # The terminal's local modes once everything has exited.
        self.lflag = lflag

    def restored(self):
        """The alternate screen left and the cursor shown after the last frame, and the line discipline back."""
        assert self.raw.rfind(b'\x1b[?1049l') > self.raw.rfind(b'\x1b[?1049h') >= 0, self.raw
        assert self.raw.rfind(b'\x1b[?25h') > self.raw.rfind(b'\x1b[?25l'), self.raw
        assert self.lflag & termios.ICANON and self.lflag & termios.ECHO, self.lflag


def chooser(session):
    """The chooser's pid, among this session's processes."""
    for entry in os.listdir('/proc'):
        try:
            if entry.isdigit() and os.getsid(int(entry)) == session and \
                    b'picker/choose.ts' in open(f'/proc/{entry}/cmdline', 'rb').read():
                return int(entry)
        except OSError:
            continue
    raise AssertionError('no chooser running')


def act(fd, pid, action):
    """Send keys, or ('resize', rows, columns), ('signal', number) to every
    process, ('kill', number) to the chooser alone, ('split', first, rest),
    ('blind', keys) to type and then restore the size."""
    if not isinstance(action, tuple):
        os.write(fd, action)
    elif action[0] == 'resize':
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', action[1], action[2], 0, 0))
    elif action[0] == 'signal':
        os.killpg(pid, action[1])
    elif action[0] == 'kill':
        os.kill(chooser(pid), action[1])
    elif action[0] == 'blind':
        # Keys while nothing shows them, then the terminal back to 24×80.
        os.write(fd, action[1])
        time.sleep(0.3)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    elif action[0] == 'split':
        # One key in two writes, as a slow link delivers it.
        os.write(fd, action[1])
        time.sleep(0.05)
        os.write(fd, action[2])


def run(steps, expected, overrides=None, status=0, args=None, size=(24, 80), state=None, prefix=(), cwd=None):
    """Run agent-distro on a PTY. Each step waits for its marker in the output
    since the previous step, then acts (see `act`). An override of None
    removes that variable; `prefix` runs agent-distro under another command."""
    scratch = tempfile.TemporaryDirectory()
    home = state or scratch.name
    pending = list(steps)
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, AI_GATEWAY='0', TERM='xterm-256color', XDG_STATE_HOME=home)
        for name in ('AI_PROFILE', 'AI_HARNESS', 'NO_COLOR'):
            env.pop(name, None)
        env.update(overrides or {})
        env = {name: value for name, value in env.items() if value is not None}
        command = list(prefix) + ['agent-distro'] + (args if args is not None else ['--version'])
        if cwd:
            os.chdir(cwd)
        os.execvpe(command[0], command, env)
    # Size the terminal before the picker starts.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', *size, 0, 0))
    output = b''
    since = 0
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
        if pending and pending[0][0] in ANSI.sub(b'', output[since:]):
            time.sleep(0.5)
            since = len(output)
            act(fd, pid, pending.pop(0)[1])
    else:
        os.kill(pid, 9)
        raise AssertionError(output)
    _, result = os.waitpid(pid, 0)
    lflag = termios.tcgetattr(fd)[3]
    os.close(fd)
    path = os.path.join(home, 'agent-distro', 'last-choice')
    choice = open(path).read().strip() if os.path.exists(path) else None
    scratch.cleanup()
    assert not pending, (pending, output)
    assert status is None or os.waitstatus_to_exitcode(result) == status, (result, output)
    drawn = ANSI.sub(b'', output)
    assert expected in drawn, (expected, output)
    return Run(output, choice, lflag)


def flow(keys):
    """Wait for the menu, then send `keys`."""
    return [(LAUNCH, keys)]


def version(harness):
    return subprocess.check_output(
        ['agent-distro', '--version'],
        env=dict(os.environ, AI_GATEWAY='0', AI_HARNESS=harness),
        timeout=60,
    ).strip()


def count(n):
    return (b'1 match' if n == 1 else f'{n} matches'.encode()) if n else b'no matches'


# `--list --json` is the menu the picker draws, with the profile in effect;
# `--list` the same rows under a line naming that profile.
listed = json.loads(subprocess.check_output(['agent-distro', '--list', '--json']))
assert list(listed) == ['profiles', 'profile'], listed
assert listed['profiles'] == LISTING['profiles'], listed
assert listed['profile'] == {'name': DEFAULT, 'description': BUILTIN['description'], 'source': 'builtin', 'origin': DEFAULT}, listed
for profile in listed['profiles']:
    assert list(profile) == ['description', 'harnesses', 'name'], profile
    assert [row['name'] for row in profile['harnesses']] == NAMES, profile
    for row in profile['harnesses']:
        assert list(row) == ['name', 'tagline', 'title', 'version'], row
        assert '+' not in row['version'], row
        assert not row['tagline'].startswith(row['title']), row
listing = subprocess.check_output(['agent-distro', '--list']).decode().splitlines()
assert listing == [f"{DEFAULT} · {BUILTIN['description']} · built in"] + [
    f"{row['name']} {row['title']} {row['version']}" for row in ROWS], listing

# The first screen: the profile in effect and the count in the header, every
# harness row with its version, and the highlighted harness in the panel beside it.
first = run(flow(b'\r'), version(NAMES[0]), size=(24, 120))
drawn = first.drawn
assert first.choice == NAMES[0], first.choice
assert f'agent-distro · {DEFAULT}'.encode() in drawn, drawn
assert f'{len(ROWS)} harnesses'.encode() in drawn, drawn
assert b'built in' in drawn, drawn
assert b'\xe2\x86\x90\xe2\x86\x92 profile' not in drawn, drawn
for row in ROWS:
    for field in ('title', 'version'):
        assert row[field].encode() in drawn, (row, drawn)
# The panel shows the highlighted harness in full: its tagline, its status and
# the profile line under it.
assert ROWS[0]['tagline'].encode() in drawn, drawn
assert LISTING['profiles'][0]['description'][:15].encode() in drawn, drawn
assert '╭─ agent-distro'.encode() in drawn and b'/ filter' in drawn, drawn
assert colours(first.raw), first.raw
first.restored()

# 80×24 holds the same rows; the panel wraps rather than cutting anything.
standard = run(flow(b'\r'), version(NAMES[0]))
for row in ROWS:
    for field in ('title', 'version'):
        assert row[field].encode() in standard.drawn, (row, standard.drawn)
assert ROWS[0]['tagline'].encode() in standard.drawn, standard.drawn

# The auth status: a seeded Claude account and Codex tokens are in the panel
# when that row is highlighted, with the ✓ mark on the row; without the files,
# the panel says "Not signed in".
CHECK = '\u2713'.encode()
with tempfile.TemporaryDirectory() as auth_home:
    os.makedirs(os.path.join(auth_home, '.codex'))
    with open(os.path.join(auth_home, '.claude.json'), 'w') as handle:
        json.dump({'oauthAccount': {'emailAddress': 'picker@example.com'}}, handle)
    # Codex's id_token is an OpenID JWT: its payload's `email` names the account.
    claims = base64.urlsafe_b64encode(json.dumps({'email': 'codex@example.com'}).encode()).decode().rstrip('=')
    with open(os.path.join(auth_home, '.codex', 'auth.json'), 'w') as handle:
        json.dump({'tokens': {'access_token': 'x', 'id_token': 'header.' + claims + '.signature'}}, handle)
    # The Claude row (third) is highlighted, so the panel lists its email.
    seeded = run([(LAUNCH, DOWN * 2), (b'picker@example.com', b'\r')], version(NAMES[2]),
                 {'HOME': auth_home}, size=(24, 120))
    assert CHECK in seeded.drawn, seeded.drawn
    assert b'Signed in' in seeded.drawn, seeded.drawn
    assert seeded.choice == NAMES[2], seeded.choice
    # The Codex row: the email decoded from its id_token.
    codex = run([(LAUNCH, DOWN), (b'codex@example.com', b'\r')], version(NAMES[1]), {'HOME': auth_home})
    assert b'codex@example.com' in codex.drawn, codex.drawn
    # The numbered fallback carries the one-line status before the version.
    fallback = run([(PLAIN_PROMPT, b'\r')], version(NAMES[0]), {'HOME': auth_home}, size=(len(ROWS) + 5, 120))
    assert b'picker@example.com' in fallback.drawn, fallback.drawn
    assert b'codex@example.com' in fallback.drawn, fallback.drawn
with tempfile.TemporaryDirectory() as bare_home:
    bare = run(flow(b'\r'), version(NAMES[0]), {'HOME': bare_home})
    assert b'Not signed in' in bare.drawn, bare.drawn
    assert CHECK not in bare.drawn, bare.drawn

# OMP's own store: the panel lists one provider per line, the enabled credential
# only, and nothing warns on stderr (a Node that warns about node:sqlite must
# fail here rather than corrupt the picker).
with tempfile.TemporaryDirectory() as omp_home:
    os.makedirs(os.path.join(omp_home, '.omp', 'agent'))
    database = sqlite3.connect(os.path.join(omp_home, '.omp', 'agent', 'agent.db'))
    database.execute('CREATE TABLE auth_credentials (provider TEXT NOT NULL, disabled_cause TEXT)')
    database.execute('INSERT INTO auth_credentials (provider, disabled_cause) VALUES (?, NULL)', ('anthropic',))
    database.execute('INSERT INTO auth_credentials (provider, disabled_cause) VALUES (?, ?)', ('openai', 'revoked'))
    database.commit()
    database.close()
    omp = run(flow(b'\r'), version(NAMES[0]), {'HOME': omp_home, 'PI_CODING_AGENT_DIR': None}, size=(24, 120))
    assert b'anthropic' in omp.drawn, omp.drawn
    assert b'openai' not in omp.drawn, omp.drawn
    assert CHECK in omp.drawn, omp.drawn
    assert b'Warning' not in omp.drawn, omp.drawn
# A store OMP has not written a credential to yet is "not signed in", not blank.
with tempfile.TemporaryDirectory() as fresh_home:
    os.makedirs(os.path.join(fresh_home, '.omp', 'agent'))
    database = sqlite3.connect(os.path.join(fresh_home, '.omp', 'agent', 'agent.db'))
    database.execute('CREATE TABLE other (x)')
    database.commit()
    database.close()
    fresh = run(flow(b'\r'), version(NAMES[0]), {'HOME': fresh_home, 'PI_CODING_AGENT_DIR': None})
    assert b'Not signed in' in fresh.drawn, fresh.drawn

for row, harness in enumerate(ROWS):
    expected = version(harness['name'])
    picked = run(flow(DOWN * row + b'\r'), expected)
    assert harness['version'].encode() in picked.drawn, picked.drawn
    assert picked.choice == harness['name'], picked.choice
    run([], expected, args=[DEFAULT, harness['name'], '--version'])
    run([], expected, args=[harness['name'], '--version'])
# The built-in name, positional or in AI_PROFILE, is the built-in profile.
for narrowed in (run([(LAUNCH, b'\r')], version(NAMES[0]), {'AI_PROFILE': DEFAULT}),
                 run([(LAUNCH, b'\r')], version(NAMES[0]), args=[DEFAULT, '--version'])):
    assert f'agent-distro · {DEFAULT}'.encode() in narrowed.drawn, narrowed.drawn

# A profile chosen by reference, or found in the repository: the header names
# it and where it came from, and `--list` says the same.
with tempfile.TemporaryDirectory() as work:
    repo = os.path.join(work, 'repo')
    os.makedirs(os.path.join(repo, '.git'))
    os.makedirs(os.path.join(repo, 'nested', 'deep'))
    with open(os.path.join(repo, 'agent-distro.nix'), 'w') as handle:
        handle.write('{ name = "repo"; description = "Found in the repository"; plugins = [ ]; gateway = null; }\n')
    other = os.path.join(work, 'other')
    os.makedirs(other)
    with open(os.path.join(other, 'agent-distro.nix'), 'w') as handle:
        handle.write('{ name = "chosen"; description = "Chosen on the command line"; plugins = [ ]; gateway = null; }\n')
    nested = os.path.join(repo, 'nested', 'deep')
    found = run(flow(b'\r'), version(NAMES[0]), cwd=nested)
    assert b'agent-distro \xc2\xb7 repo' in found.drawn, found.drawn
    assert b'Found in the repository' in found.drawn, found.drawn
    assert found.choice == NAMES[0], found.choice
    listed = json.loads(subprocess.check_output(['agent-distro', '--list', '--json'], cwd=nested))
    assert listed['profile'] == {'name': 'repo', 'description': 'Found in the repository', 'source': 'repository',
                                 'origin': os.path.join(repo, 'agent-distro.nix')}, listed
    # The positional selector wins over the repository; a relative path starts with ./.
    chosen = run(flow(b'\r'), version(NAMES[0]), args=['../../../other', '--version'], cwd=nested, size=(24, 120))
    assert b'agent-distro \xc2\xb7 chosen' in chosen.drawn, chosen.drawn
    assert b'chosen as ../../../other' in chosen.drawn, chosen.drawn
    run([], version(NAMES[1]), args=[other, NAMES[1], '--version'], cwd=nested)

# Environment selectors win over consumed positional selectors.
run([], version(NAMES[0]), {'AI_HARNESS': NAMES[0]}, args=[NAMES[-1], '--version'])
run([], version(NAMES[0]), {'AI_HARNESS': NAMES[0]}, args=[DEFAULT, NAMES[-1], '--version'])
run([], version(NAMES[0]), {'AI_HARNESS': NAMES[0]})
run([], ('valid values: ' + ', '.join(NAMES)).encode(), {'AI_HARNESS': 'bad'}, status=1)
run([], b'AI_PROFILE=nonesuch: not a built-in profile', {'AI_PROFILE': 'nonesuch'}, status=1)

# The filter shows the query and its match count; Enter takes the first match.
target = max(ROWS, key=lambda row: len(row['title']))
query = target['title']
matches = [row for row in ROWS if query.lower() in (row['title'] + ' ' + row['tagline']).lower()]
filtered = run(flow(b'/' + query.encode()) + [(count(len(matches)), b'\r')],
               version(matches[0]['name']))
assert ('/ ' + query).encode() in filtered.drawn, filtered.drawn
run(flow(b'/no-matches') + [(b'no matches', ESCAPE + b'\r')], version(NAMES[0]))
# Backspace edits the query; arrows move among the matches.
run(flow(b'/' + query.encode() + b'x') + [(b'no matches', b'\x7f'), (count(len(matches)), b'\r')],
    version(matches[0]['name']))

# Quitting chooses nothing, remembers nothing, and gives the terminal back.
quit = run(flow(b'q'), LAUNCH)
assert quit.choice is None
quit.restored()
for keys in (b'\x03', ESCAPE):
    quit = run([(LAUNCH, keys)], LAUNCH)
    assert quit.choice is None
    quit.restored()
# So does a signal. SIGINT to the chooser quits like Ctrl-C, exit 0; sent to
# the whole group it also ends the shell, as for any script.
quit = run([(LAUNCH, ('kill', signal.SIGINT))], LAUNCH)
assert quit.choice is None
quit.restored()
for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    run([(LAUNCH, ('signal', number))], LAUNCH, status=None).restored()
# SIGTERM to the chooser alone: its status reaches the caller.
run([(LAUNCH, ('kill', signal.SIGTERM))], LAUNCH, status=143).restored()
# Any failure other than quitting keeps its status (node rejects the option with 9).
run([], b'NODE_OPTIONS', {'NODE_OPTIONS': '--no-such-option'}, status=9)
# An arrow split across packets is still an arrow, not Escape.
assert run([(LAUNCH, ('split', ESCAPE, b'[B')), (LAUNCH, b'\r')],
           version(NAMES[1])).choice == NAMES[1]
# Escape quits, with or without a filter open.
assert run([(LAUNCH, b'/zzz'), (b'no matches', ESCAPE), (LAUNCH, ESCAPE)], LAUNCH).choice is None

# NO_COLOR keeps attributes (bold, dim) but drops every colour.
plain_colours = run([(LAUNCH, b'q')], b'agent-distro', {'NO_COLOR': '1'})
assert not colours(plain_colours.raw), plain_colours.raw
assert not colours(run([(LAUNCH, b'q')], b'agent-distro', {'TERM': 'vt100'}).raw)

# Too small, or unsupported, from the start: the numbered list on stderr.
# Input that is not a choice says so and asks again.
numbered = [(PLAIN_PROMPT, b'abc\r'), (b'Not a choice: abc', b'\r')]
for overrides, size, prefix in [({}, (len(ROWS) + 5, 120), ()), ({}, (24, 20), ()), ({'TERM': 'dumb'}, (24, 120), ()),
                                ({'TERM': None}, (24, 120), ()), ({}, (24, 120), ('setsid', '-w'))]:
    small = run(numbered, version(NAMES[0]), overrides, size=size, prefix=prefix)
    assert '╭'.encode() not in small.drawn, small.drawn
    assert f'1. {ROWS[0]["title"]}  {ROWS[0]["tagline"]}  not signed in  {ROWS[0]["version"]}'.encode() in small.drawn, small.drawn
    assert small.choice == NAMES[0], small.choice
    assert f'agent-distro · {DEFAULT}\r\n{BUILTIN["description"]} · built in\r\n'.encode() in small.drawn, small.drawn
    assert b'h profiles' not in small.drawn, small.drawn
# Growing redraws. Shrinking below the minimum shows a notice and keeps the
# session, filter and cursor included, until the terminal grows again.
run(flow(('resize', 30, 100)) + [(LAUNCH, b'\r')], version(NAMES[0]))
target = ROWS[-1]
matches = [row for row in ROWS if target['title'].lower() in (row['title'] + ' ' + row['tagline']).lower()]
held = run(flow(b'/' + target['title'].encode() + DOWN * matches.index(target))
           + [(count(len(matches)), ('resize', 8, 30)), (TOO_SMALL, ('resize', 24, 80)),
              (LAUNCH, b'\r')], version(target['name']))
assert held.choice == target['name'], held.choice
assert PLAIN_PROMPT not in held.drawn, held.drawn
# The notice fits the terminal, and behind it only q acts: Enter and text
# typed blind change nothing, and q quits even with a filter open.
typing = flow(b'/' + target['title'].encode() + DOWN * matches.index(target)) + [(count(len(matches)), ('resize', 8, 30))]
blind = run(typing + [(TOO_SMALL, ('blind', b'\rx')), (LAUNCH, b'\r')], version(target['name']))
assert blind.choice == target['name'], blind.choice
assert b'press q to quit' in blind.drawn, blind.drawn
assert (target['title'] + 'x').encode() not in blind.drawn, blind.drawn
assert run(typing + [(TOO_SMALL, b'q')], TOO_SMALL).choice is None

# A terminal that hangs up ends the chooser as a quit: exit 0, nothing printed.
script = open(shutil.which('agent-distro')).read()
node, chooser_ts = re.search(r'(/nix/store/[^ ]+/bin/node) (/nix/store/[^ ]+/src/picker/choose\.ts)', script).groups()
pid, fd = pty.fork()
if pid == 0:
    os.execve(node, [node, chooser_ts, json.dumps(LISTING)], dict(os.environ, TERM='xterm-256color'))
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
output = b''
while LAUNCH not in ANSI.sub(b'', output):
    assert select.select([fd], [], [], 30)[0], output
    output += os.read(fd, 65536)
os.close(fd)
_, result = os.waitpid(pid, 0)
assert os.waitstatus_to_exitcode(result) == 0, result

with tempfile.TemporaryDirectory() as state:
    path = os.path.join(state, 'agent-distro', 'last-choice')
    os.makedirs(os.path.dirname(path))
    # The harness last chosen keeps its dot and has the cursor; a choice
    # remembered with its profile, as releases with a profile selector wrote
    # it, is read as its harness.
    for remembered in (NAMES[-1], 'juspay/' + NAMES[-1]):
        with open(path, 'w') as handle:
            handle.write(remembered + '\n')
        marked = run([(LAUNCH, b'\r')], version(NAMES[-1]), state=state)
        assert b'\xe2\x80\xa2' in marked.drawn, marked.drawn
        assert f'{ROWS[-1]["title"]} {ROWS[-1]["version"]}'.encode() in marked.drawn, marked.drawn
        assert marked.choice == NAMES[-1], marked.choice
    assert run([], version(NAMES[0]), args=[NAMES[0], '--version'], state=state).choice == NAMES[-1]
    assert run([(LAUNCH, b'k\r')], version(NAMES[-2]), state=state).choice == NAMES[-2]

    # Naming the profile still shows the chooser, so its selection is remembered.
    narrowed = run([(LAUNCH, b'/no-matches'), (b'no matches', ESCAPE + b'\r')],
                   version(NAMES[0]), args=[DEFAULT, '--version'], state=state)
    assert narrowed.choice == NAMES[0], narrowed.choice
    for args, extra in [([DEFAULT, NAMES[-1], '--version'], {}),
                        (['--version'], {'AI_HARNESS': NAMES[-1]})]:
        direct = run([], version(NAMES[-1]), extra, args=args, state=state)
        assert direct.choice == NAMES[0], direct.choice
