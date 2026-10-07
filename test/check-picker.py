"""Drive the picker over a PTY: panes, filter, shortcuts, fallback and `--list`."""
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
ESCAPE = b'\x1b'
# The footer names what Enter does, so it tells which pane has focus.
PROFILE_FOCUS = b'Enter pick profile'
HARNESS_FOCUS = b'Enter launch'
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
    """Pick a profile (when there are several) by position, then send `keys`."""
    return ([(PROFILE_FOCUS, DOWN * profile_index + b'\r')] if OTHERS else []) + [(HARNESS_FOCUS, keys)]


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

# The first screen: header counts, panes, every row of the default profile,
# in full on a wide terminal.
first = run(flow(b'\r'), version(DEFAULT, NAMES[0]), size=(24, 120))
drawn = first.drawn
assert first.choice == DEFAULT + '/' + NAMES[0], first.choice
if OTHERS:
    assert f'{len(PROFILES)} profiles · {len(ROWS)} harnesses'.encode() in drawn, drawn
    assert b'Profiles' in drawn and f'Harnesses · {DEFAULT}'.encode() in drawn, drawn
    assert '← profiles'.encode() in drawn and b'Tab switch pane' in drawn, drawn
    for name in PROFILES:
        assert name.encode() in drawn, drawn
else:
    assert f'agent-distro · {DEFAULT}'.encode() in drawn, drawn
    assert LISTING['profiles'][0]['description'].encode() in drawn, drawn
    assert f'{len(ROWS)} harnesses'.encode() in drawn, drawn
    assert 'Harnesses · '.encode() not in drawn and '← profiles'.encode() not in drawn, drawn
    assert b'Tab' not in drawn, drawn
for row in ROWS:
    for field in ('title', 'tagline', 'version'):
        assert row[field].encode() in drawn, (row, drawn)
assert '╭─ agent-distro'.encode() in drawn and b'/ filter' in drawn, drawn
assert colours(first.raw), first.raw
first.restored()
# 80×24 holds the same rows; taglines may be cut, never titles or versions.
standard = run(flow(b'\r'), version(DEFAULT, NAMES[0]))
for row in ROWS:
    for field in ('title', 'version'):
        assert row[field].encode() in standard.drawn, (row, standard.drawn)

# The auth column: a seeded Claude account and Codex tokens are drawn next to
# their rows, in the box and appended to the numbered list; without the files,
# those rows say "not signed in".
def row_line(drawn, title):
    return next(line for line in drawn.decode().splitlines() if title in line)

with tempfile.TemporaryDirectory() as auth_home:
    os.makedirs(os.path.join(auth_home, '.codex'))
    with open(os.path.join(auth_home, '.claude.json'), 'w') as handle:
        json.dump({'oauthAccount': {'emailAddress': 'picker@example.com'}}, handle)
    with open(os.path.join(auth_home, '.codex', 'auth.json'), 'w') as handle:
        json.dump({'tokens': {'access_token': 'x'}, 'OPENAI_API_KEY': None}, handle)
    seeded = run(flow(b'\r'), version(DEFAULT, NAMES[0]), {'HOME': auth_home}, size=(24, 120))
    assert 'picker@example.com' in row_line(seeded.drawn, 'Claude Code'), seeded.drawn
    assert 'ChatGPT' in row_line(seeded.drawn, 'Codex'), seeded.drawn
    # The numbered fallback, where the status sits before the version.
    plain_steps = ([(PLAIN_PROFILES, b'\r')] if OTHERS else []) + [(PLAIN_PROMPT, b'\r')]
    fallback = run(plain_steps, version(DEFAULT, NAMES[0]), {'HOME': auth_home}, size=(len(ROWS) + 5, 120))
    assert b'picker@example.com' in fallback.drawn, fallback.drawn
    assert b'ChatGPT' in fallback.drawn, fallback.drawn
with tempfile.TemporaryDirectory() as bare_home:
    bare = run(flow(b'\r'), version(DEFAULT, NAMES[0]), {'HOME': bare_home}, size=(24, 120))
    assert 'not signed in' in row_line(bare.drawn, 'Claude Code'), bare.drawn
    assert 'not signed in' in row_line(bare.drawn, 'Codex'), bare.drawn

# OMP's own store: the enabled credential is drawn on its row, a disabled one
# is not, and nothing warns on stderr (a Node that warns about node:sqlite must
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
    assert 'anthropic' in row_line(omp.drawn, 'Oh My Pi'), omp.drawn
    assert 'openai' not in row_line(omp.drawn, 'Oh My Pi'), omp.drawn
    assert b'Warning' not in omp.drawn, omp.drawn
# A store OMP has not written a credential to yet is "not signed in", not blank.
with tempfile.TemporaryDirectory() as fresh_home:
    os.makedirs(os.path.join(fresh_home, '.omp', 'agent'))
    database = sqlite3.connect(os.path.join(fresh_home, '.omp', 'agent', 'agent.db'))
    database.execute('CREATE TABLE other (x)')
    database.commit()
    database.close()
    fresh = run(flow(b'\r'), version(DEFAULT, NAMES[0]), {'HOME': fresh_home, 'PI_CODING_AGENT_DIR': None}, size=(24, 120))
    assert 'not signed in' in row_line(fresh.drawn, 'Oh My Pi'), fresh.drawn

for index, profile in enumerate(PROFILES):
    for row, harness in enumerate(HARNESSES[profile]):
        expected = version(profile, harness['name'])
        picked = run(flow(DOWN * row + b'\r', index), expected)
        assert harness['version'].encode() in picked.drawn, picked.drawn
        assert picked.choice == profile + '/' + harness['name'], picked.choice
        run([], expected, args=[profile, harness['name'], '--version'])
    for narrowed in (run([(HARNESS_FOCUS, b'\r')], version(profile, NAMES[0]), {'AI_PROFILE': profile}),
                     run([(HARNESS_FOCUS, b'\r')], version(profile, NAMES[0]), args=[profile, '--version'])):
        assert f'agent-distro · {profile}'.encode() in narrowed.drawn, narrowed.drawn
        assert PROFILE_FOCUS not in narrowed.drawn, narrowed.drawn
        assert '← profiles'.encode() not in narrowed.drawn, narrowed.drawn

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
quit = run(flow(b'q'), PROFILE_FOCUS if OTHERS else HARNESS_FOCUS)
assert quit.choice is None
quit.restored()
TOP = PROFILE_FOCUS if OTHERS else HARNESS_FOCUS
for keys in (b'\x03', ESCAPE):
    quit = run([(TOP, keys)], TOP)
    assert quit.choice is None
    quit.restored()
# So does a signal. SIGINT to the chooser quits like Ctrl-C, exit 0; sent to
# the whole group it also ends the shell, as for any script.
quit = run([(TOP, ('kill', signal.SIGINT))], TOP)
assert quit.choice is None
quit.restored()
for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    run([(TOP, ('signal', number))], TOP, status=None).restored()
# SIGTERM to the chooser alone: its status reaches the caller.
run([(TOP, ('kill', signal.SIGTERM))], TOP, status=143).restored()
# Any failure other than quitting keeps its status (node rejects the option with 9).
run([], b'NODE_OPTIONS', {'NODE_OPTIONS': '--no-such-option'}, status=9)
# An arrow split across packets is still an arrow, not Escape.
assert run(flow(('split', ESCAPE, b'[B')) + [(HARNESS_FOCUS, b'\r')],
           version(DEFAULT, NAMES[1])).choice == DEFAULT + '/' + NAMES[1]
if OTHERS:
    assert run([(PROFILE_FOCUS, ESCAPE)], PROFILE_FOCUS).choice is None
    assert run([(PROFILE_FOCUS, b'\r'), (HARNESS_FOCUS, b'h'), (PROFILE_FOCUS, ESCAPE)], HARNESS_FOCUS).choice is None
    assert run([(PROFILE_FOCUS, b'\r'), (HARNESS_FOCUS, ESCAPE), (PROFILE_FOCUS, b'q')], HARNESS_FOCUS).choice is None
    # Tab switches panes; moving the profile cursor previews its harnesses.
    last = PROFILES[-1]
    tabbed = run([(PROFILE_FOCUS, b'\t'), (HARNESS_FOCUS, b'\t'),
                  (PROFILE_FOCUS, DOWN * len(OTHERS)), (f'Harnesses · {last}'.encode(), b'\t'),
                  (HARNESS_FOCUS, b'\r')], version(last, NAMES[0]))
    assert tabbed.choice == last + '/' + NAMES[0], tabbed.choice
    # Escape and an arrow read as one sequence are both kept: back, then down.
    run(flow(ESCAPE + DOWN) + [(PROFILE_FOCUS, b'\r'), (HARNESS_FOCUS, b'\r')], version(PROFILES[1], NAMES[0]))
    # The profile filter matches names and descriptions.
    hits = [p for p in LISTING['profiles'] if last.lower() in (p['name'] + ' ' + p['description']).lower()]
    run([(PROFILE_FOCUS, b'/' + last.encode()), (count(len(hits)), b'\r'), (HARNESS_FOCUS, b'\r')],
        version(hits[0]['name'], NAMES[0]))
else:
    assert run([(HARNESS_FOCUS, ESCAPE)], HARNESS_FOCUS).choice is None
    assert run([(HARNESS_FOCUS, b'h')], HARNESS_FOCUS).choice is None

# NO_COLOR keeps attributes (bold, dim) but drops every colour.
plain_colours = run([(PROFILE_FOCUS if OTHERS else HARNESS_FOCUS, b'q')], b'agent-distro', {'NO_COLOR': '1'})
assert not colours(plain_colours.raw), plain_colours.raw
assert not colours(run([(PROFILE_FOCUS if OTHERS else HARNESS_FOCUS, b'q')], b'agent-distro', {'TERM': 'vt100'}).raw)

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
run(flow(('resize', 30, 100)) + [(HARNESS_FOCUS, b'\r')], version(DEFAULT, NAMES[0]))
target = ROWS[-1]
matches = [row for row in ROWS if target['title'].lower() in (row['title'] + ' ' + row['tagline']).lower()]
held = run(flow(b'/' + target['title'].encode() + DOWN * matches.index(target))
           + [(count(len(matches)), ('resize', 8, 30)), (TOO_SMALL, ('resize', 24, 80)),
              (HARNESS_FOCUS, b'\r')], version(DEFAULT, target['name']))
assert held.choice == DEFAULT + '/' + target['name'], held.choice
assert PLAIN_PROMPT not in held.drawn, held.drawn
# The notice fits the terminal, and behind it only q acts: Enter and text
# typed blind change nothing, and q quits even with a filter open.
typing = flow(b'/' + target['title'].encode() + DOWN * matches.index(target)) + [(count(len(matches)), ('resize', 8, 30))]
blind = run(typing + [(TOO_SMALL, ('blind', b'\rx')), (HARNESS_FOCUS, b'\r')], version(DEFAULT, target['name']))
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
while TOP not in ANSI.sub(b'', output):
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
    # Profiles still take focus first; the cursor starts on the remembered
    # profile, then on its remembered harness, both marked.
    remembered_flow = lambda keys: ([(PROFILE_FOCUS, b'\r')] if OTHERS else []) + [(HARNESS_FOCUS, keys)]
    marked = run(remembered_flow(b'\r'), version(PROFILES[-1], NAMES[-1]), state=state)
    title = HARNESSES[PROFILES[-1]][-1]['title']
    assert f'• {title}'.encode() in marked.drawn, marked.drawn
    if OTHERS:
        assert f'• {PROFILES[-1]}'.encode() in marked.drawn, marked.drawn
    assert marked.choice == remembered
    assert run([], version(DEFAULT, NAMES[0]), args=[NAMES[0], '--version'], state=state).choice == remembered
    assert run(remembered_flow(b'k\r'), version(PROFILES[-1], NAMES[-2]), state=state).choice.endswith('/' + NAMES[-2])

    # Narrowing still shows the chooser, so its selection must be remembered.
    narrowed = run([(HARNESS_FOCUS, b'/no-matches'), (b'no matches', ESCAPE + b'\r')],
                   version(DEFAULT, NAMES[0]), args=[DEFAULT, '--version'], state=state)
    assert narrowed.choice == DEFAULT + '/' + NAMES[0], narrowed.choice
    for args, extra in [([DEFAULT, NAMES[-1], '--version'], {}),
                        (['--version'], {'AI_HARNESS': NAMES[-1]})]:
        direct = run([], version(DEFAULT, NAMES[-1]), extra, args=args, state=state)
        assert direct.choice == DEFAULT + '/' + NAMES[0], direct.choice
