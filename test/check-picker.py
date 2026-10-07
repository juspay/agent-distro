"""Drive the picker over a PTY: profiles as tabs, filter, shortcuts, fallback and `--list`."""
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
PROFILES = [profile['name'] for profile in LISTING['profiles']]
# The first profile is the default.
DEFAULT = PROFILES[0]
OTHERS = PROFILES[1:]
HARNESSES = {profile['name']: profile['harnesses'] for profile in LISTING['profiles']}
ROWS = HARNESSES[DEFAULT]
NAMES = [row['name'] for row in ROWS]
DOWN = b'\x1b[B'
RIGHT = b'\x1b[C'
SHIFT_TAB = b'\x1b[Z'
ESCAPE = b'\x1b'
# The footer names what Enter does, and is there from the first frame.
LAUNCH = b'Enter launch'
# The numbered list's prompts, on the profile list and on a harness list.
PLAIN_PROFILES = b'Pick a profile ['
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


def run(steps, expected, overrides=None, status=0, args=None, size=(24, 80), state=None, prefix=()):
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


def flow(keys, profile_index=0):
    """Switch to a profile by position, then send `keys`."""
    steps = [(LAUNCH, RIGHT * profile_index)] if profile_index else []
    return steps + [(LAUNCH, keys)]


def version(profile, harness):
    return subprocess.check_output(
        ['agent-distro', '--version'],
        env=dict(os.environ, AI_GATEWAY='0', AI_PROFILE=profile, AI_HARNESS=harness),
        timeout=60,
    ).strip()


def count(n):
    return (b'1 match' if n == 1 else f'{n} matches'.encode()) if n else b'no matches'


# `--list --json` is the menu the picker draws, and `--list` the same rows.
listed = json.loads(subprocess.check_output(['agent-distro', '--list', '--json']))
assert listed == LISTING, listed
assert list(listed) == ['profiles'], listed
for profile in listed['profiles']:
    assert list(profile) == ['description', 'harnesses', 'name'], profile
    assert [row['name'] for row in profile['harnesses']] == NAMES, profile
    for row in profile['harnesses']:
        assert list(row) == ['name', 'tagline', 'title', 'version'], row
        assert '+' not in row['version'], row
        assert not row['tagline'].startswith(row['title']), row
listing = subprocess.check_output(['agent-distro', '--list']).decode().splitlines()
assert listing == [f"{profile} {row['name']} {row['title']} {row['version']}"
                   for profile in PROFILES for row in HARNESSES[profile]], listing

# The first screen: the profile tabs and count in the header, every harness row
# with its version, and the highlighted harness in the panel beside it.
first = run(flow(b'\r'), version(DEFAULT, NAMES[0]), size=(24, 120))
drawn = first.drawn
assert first.choice == DEFAULT + '/' + NAMES[0], first.choice
if OTHERS:
    assert f'{len(ROWS)} harnesses'.encode() in drawn, drawn
    assert b'\xe2\x86\x90\xe2\x86\x92 profile' in drawn, drawn  # ←→ profile
    for name in PROFILES:
        assert name.encode() in drawn, drawn
else:
    assert f'agent-distro · {DEFAULT}'.encode() in drawn, drawn
    assert f'{len(ROWS)} harnesses'.encode() in drawn, drawn
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
standard = run(flow(b'\r'), version(DEFAULT, NAMES[0]))
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
    with open(os.path.join(auth_home, '.codex', 'auth.json'), 'w') as handle:
        json.dump({'tokens': {'access_token': 'x'}, 'OPENAI_API_KEY': None}, handle)
    # The Claude row (third) is highlighted, so the panel lists its email.
    seeded = run([(LAUNCH, DOWN * 2), (b'picker@example.com', b'\r')], version(DEFAULT, NAMES[2]),
                 {'HOME': auth_home}, size=(24, 120))
    assert CHECK in seeded.drawn, seeded.drawn
    assert b'Signed in' in seeded.drawn, seeded.drawn
    assert seeded.choice == DEFAULT + '/' + NAMES[2], seeded.choice
    # The Codex row: ChatGPT from its `tokens`.
    codex = run([(LAUNCH, DOWN), (b'ChatGPT', b'\r')], version(DEFAULT, NAMES[1]), {'HOME': auth_home})
    assert b'ChatGPT' in codex.drawn, codex.drawn
    # The numbered fallback carries the one-line status before the version.
    plain_steps = ([(PLAIN_PROFILES, b'\r')] if OTHERS else []) + [(PLAIN_PROMPT, b'\r')]
    fallback = run(plain_steps, version(DEFAULT, NAMES[0]), {'HOME': auth_home}, size=(len(ROWS) + 5, 120))
    assert b'picker@example.com' in fallback.drawn, fallback.drawn
    assert b'ChatGPT' in fallback.drawn, fallback.drawn
with tempfile.TemporaryDirectory() as bare_home:
    bare = run(flow(b'\r'), version(DEFAULT, NAMES[0]), {'HOME': bare_home})
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
    omp = run(flow(b'\r'), version(DEFAULT, NAMES[0]), {'HOME': omp_home, 'PI_CODING_AGENT_DIR': None}, size=(24, 120))
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
    fresh = run(flow(b'\r'), version(DEFAULT, NAMES[0]), {'HOME': fresh_home, 'PI_CODING_AGENT_DIR': None})
    assert b'Not signed in' in fresh.drawn, fresh.drawn

for index, profile in enumerate(PROFILES):
    for row, harness in enumerate(HARNESSES[profile]):
        expected = version(profile, harness['name'])
        picked = run(flow(DOWN * row + b'\r', index), expected)
        assert harness['version'].encode() in picked.drawn, picked.drawn
        assert picked.choice == profile + '/' + harness['name'], picked.choice
        run([], expected, args=[profile, harness['name'], '--version'])
    for narrowed in (run([(LAUNCH, b'\r')], version(profile, NAMES[0]), {'AI_PROFILE': profile}),
                     run([(LAUNCH, b'\r')], version(profile, NAMES[0]), args=[profile, '--version'])):
        assert f'agent-distro · {profile}'.encode() in narrowed.drawn, narrowed.drawn
        assert b'\xe2\x86\x90\xe2\x86\x92 profile' not in narrowed.drawn, narrowed.drawn

for name in NAMES:
    run([], version(DEFAULT, name), args=[name, '--version'])

# Environment selectors win over consumed positional selectors.
run([], version(DEFAULT, NAMES[0]), {'AI_HARNESS': NAMES[0]}, args=[NAMES[-1], '--version'])
run([], version(DEFAULT, NAMES[0]), {'AI_PROFILE': DEFAULT}, args=[PROFILES[-1], NAMES[0], '--version'])
run([], version(DEFAULT, NAMES[0]), {'AI_HARNESS': NAMES[0]})
run([], ('valid values: ' + ', '.join(NAMES)).encode(), {'AI_HARNESS': 'bad'}, status=1)
run([], b'Invalid AI_PROFILE', {'AI_PROFILE': 'nonesuch'}, status=1)

# The filter shows the query and its match count; Enter takes the first match.
target = max(ROWS, key=lambda row: len(row['title']))
query = target['title']
matches = [row for row in ROWS if query.lower() in (row['title'] + ' ' + row['tagline']).lower()]
filtered = run(flow(b'/' + query.encode()) + [(count(len(matches)), b'\r')],
               version(DEFAULT, matches[0]['name']))
assert ('/ ' + query).encode() in filtered.drawn, filtered.drawn
run(flow(b'/no-matches') + [(b'no matches', ESCAPE + b'\r')], version(DEFAULT, NAMES[0]))
# Backspace edits the query; arrows move among the matches.
run(flow(b'/' + query.encode() + b'x') + [(b'no matches', b'\x7f'), (count(len(matches)), b'\r')],
    version(DEFAULT, matches[0]['name']))

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
           version(DEFAULT, NAMES[1])).choice == DEFAULT + '/' + NAMES[1]
# Escape quits, with or without a filter open.
assert run([(LAUNCH, b'/zzz'), (b'no matches', ESCAPE), (LAUNCH, ESCAPE)], LAUNCH).choice is None

if OTHERS:
    last = PROFILES[-1]
    # → and Tab switch profile; the panel and the list follow, and Enter launches
    # from the profile now shown.
    switched = run([(LAUNCH, RIGHT * len(OTHERS)), (f'{last} ·'.encode(), b'\r')], version(last, NAMES[0]))
    assert switched.choice == last + '/' + NAMES[0], switched.choice
    assert LISTING['profiles'][-1]['description'][:15].encode() in switched.drawn, switched.drawn
    assert run([(LAUNCH, b'\t'), (f'{PROFILES[1]} ·'.encode(), b'\r')],
               version(PROFILES[1], NAMES[0])).choice == PROFILES[1] + '/' + NAMES[0]
    # l, h and Shift-Tab switch too, and the first profile wraps round.
    assert run([(LAUNCH, b'l'), (f'{PROFILES[1]} ·'.encode(), b'\r')],
               version(PROFILES[1], NAMES[0])).choice == PROFILES[1] + '/' + NAMES[0]
    assert run([(LAUNCH, RIGHT), (LAUNCH, b'h'), (f'{DEFAULT} ·'.encode(), b'\r')],
               version(DEFAULT, NAMES[0])).choice == DEFAULT + '/' + NAMES[0]
    assert run([(LAUNCH, RIGHT), (LAUNCH, SHIFT_TAB), (f'{DEFAULT} ·'.encode(), b'\r')],
               version(DEFAULT, NAMES[0])).choice == DEFAULT + '/' + NAMES[0]
    assert run([(LAUNCH, b'\x1b[D'), (f'{last} ·'.encode(), b'\r')],
               version(last, NAMES[0])).choice == last + '/' + NAMES[0]
    # Switching profile re-renders the list for it, with the cursor on its first
    # harness, so ↓ then Enter takes that profile's second harness.
    assert run([(LAUNCH, RIGHT), (f'{last} ·'.encode(), DOWN + b'\r')],
               version(last, NAMES[1])).choice == last + '/' + NAMES[1]

# NO_COLOR keeps attributes (bold, dim) but drops every colour.
plain_colours = run([(LAUNCH, b'q')], b'agent-distro', {'NO_COLOR': '1'})
assert not colours(plain_colours.raw), plain_colours.raw
assert not colours(run([(LAUNCH, b'q')], b'agent-distro', {'TERM': 'vt100'}).raw)

# Too small, or unsupported, from the start: the numbered list on stderr.
# Input that is not a choice says so and asks again.
numbered = ([(PLAIN_PROFILES, b'\r')] if OTHERS else []) + [(PLAIN_PROMPT, b'abc\r'), (b'Not a choice: abc', b'\r')]
for overrides, size, prefix in [({}, (len(ROWS) + 5, 120), ()), ({}, (24, 20), ()), ({'TERM': 'dumb'}, (24, 120), ()),
                                ({'TERM': None}, (24, 120), ()), ({}, (24, 120), ('setsid', '-w'))]:
    small = run(numbered, version(DEFAULT, NAMES[0]), overrides, size=size, prefix=prefix)
    assert '╭'.encode() not in small.drawn, small.drawn
    assert f'1. {ROWS[0]["title"]}  {ROWS[0]["tagline"]}  not signed in  {ROWS[0]["version"]}'.encode() in small.drawn, small.drawn
    assert small.choice == DEFAULT + '/' + NAMES[0], small.choice
    if OTHERS:
        assert f'1. {DEFAULT}  {LISTING["profiles"][0]["description"]}\r\n'.encode() in small.drawn, small.drawn
        assert b'h profiles' in small.drawn, small.drawn
    else:
        assert b'h profiles' not in small.drawn, small.drawn
# Growing redraws. Shrinking below the minimum shows a notice and keeps the
# session, filter and cursor included, until the terminal grows again.
run(flow(('resize', 30, 100)) + [(LAUNCH, b'\r')], version(DEFAULT, NAMES[0]))
target = ROWS[-1]
matches = [row for row in ROWS if target['title'].lower() in (row['title'] + ' ' + row['tagline']).lower()]
held = run(flow(b'/' + target['title'].encode() + DOWN * matches.index(target))
           + [(count(len(matches)), ('resize', 8, 30)), (TOO_SMALL, ('resize', 24, 80)),
              (LAUNCH, b'\r')], version(DEFAULT, target['name']))
assert held.choice == DEFAULT + '/' + target['name'], held.choice
assert PLAIN_PROMPT not in held.drawn, held.drawn
# The notice fits the terminal, and behind it only q acts: Enter and text
# typed blind change nothing, and q quits even with a filter open.
typing = flow(b'/' + target['title'].encode() + DOWN * matches.index(target)) + [(count(len(matches)), ('resize', 8, 30))]
blind = run(typing + [(TOO_SMALL, ('blind', b'\rx')), (LAUNCH, b'\r')], version(DEFAULT, target['name']))
assert blind.choice == DEFAULT + '/' + target['name'], blind.choice
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
    remembered = PROFILES[-1] + '/' + NAMES[-1]
    with open(path, 'w') as handle:
        handle.write(remembered + '\n')
    # The default profile opens whatever was remembered; the remembered profile
    # and harness keep their dots, and switching to that profile puts the cursor
    # on the remembered harness.
    to_last = [(LAUNCH, RIGHT * len(OTHERS))] if OTHERS else []
    marked = run(to_last + [(LAUNCH, b'\r')], version(PROFILES[-1], NAMES[-1]), state=state)
    title = HARNESSES[PROFILES[-1]][-1]['title']
    # The remembered harness keeps its dot, and the panel is on it.
    assert b'\xe2\x80\xa2' in marked.drawn, marked.drawn
    assert f'{title} {HARNESSES[PROFILES[-1]][-1]["version"]}'.encode() in marked.drawn, marked.drawn
    if OTHERS:
        assert b'\xe2\x80\xa2 ' + PROFILES[-1].encode() in marked.drawn, marked.drawn
    assert marked.choice == remembered
    assert run([], version(DEFAULT, NAMES[0]), args=[NAMES[0], '--version'], state=state).choice == remembered
    assert run(to_last + [(LAUNCH, b'k\r')], version(PROFILES[-1], NAMES[-2]), state=state).choice.endswith('/' + NAMES[-2])
    # A profile switch followed by a launch is remembered too: the default still
    # opens, and switching back lands on the harness that was launched.
    if OTHERS:
        switched = run([(LAUNCH, RIGHT), (LAUNCH, b'\r')], version(PROFILES[1], NAMES[-2]), state=state)
        assert switched.choice == PROFILES[1] + '/' + NAMES[-2], switched.choice
        assert run([(LAUNCH, RIGHT), (LAUNCH, b'\r')], version(PROFILES[1], NAMES[-2]),
                   state=state).choice == PROFILES[1] + '/' + NAMES[-2]

    # Narrowing still shows the chooser, so its selection must be remembered.
    narrowed = run([(LAUNCH, b'/no-matches'), (b'no matches', ESCAPE + b'\r')],
                   version(DEFAULT, NAMES[0]), args=[DEFAULT, '--version'], state=state)
    assert narrowed.choice == DEFAULT + '/' + NAMES[0], narrowed.choice
    for args, extra in [([DEFAULT, NAMES[-1], '--version'], {}),
                        (['--version'], {'AI_HARNESS': NAMES[-1]})]:
        direct = run([], version(DEFAULT, NAMES[-1]), extra, args=args, state=state)
        assert direct.choice == DEFAULT + '/' + NAMES[0], direct.choice
