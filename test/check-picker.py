"""Drive the picker over a PTY: panes, filter, shortcuts, fallback and `--list`."""
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

LISTING = json.loads(sys.argv[1])
DEFAULT = LISTING['default']
PROFILES = [profile['name'] for profile in LISTING['profiles']]
OTHERS = PROFILES[1:]
HARNESSES = {profile['name']: profile['harnesses'] for profile in LISTING['profiles']}
ROWS = HARNESSES[DEFAULT]
NAMES = [row['name'] for row in ROWS]
DOWN = b'\x1b[B'
ESCAPE = b'\x1b'
# The footer names what Enter does, so it tells which pane has focus.
PROFILE_FOCUS = b'Enter pick profile'
HARNESS_FOCUS = b'Enter launch'
PLAIN_PROMPT = b'Choice ['
# Match displayed text independently of terminal attributes.
ANSI = re.compile(rb'\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07|[()][0-~]|[@-Z\\-_])')
SGR = re.compile(rb'\x1b\[([0-9;]*)m')


def colours(raw):
    """SGR parameters that set a colour rather than an attribute."""
    return [p for match in SGR.findall(raw) for p in match.split(b';')
            if p and (30 <= int(p) <= 49 or 90 <= int(p) <= 107)]


class Run:
    def __init__(self, raw, choice):
        self.raw = raw
        self.drawn = ANSI.sub(b'', raw)
        self.choice = choice


def run(steps, expected, overrides=None, status=0, args=None, size=(24, 120), state=None):
    """Run agent-distro on a PTY. Each step waits for its marker in the output
    since the previous step, then sends bytes or ('resize', rows, columns)."""
    scratch = tempfile.TemporaryDirectory()
    home = state or scratch.name
    pending = list(steps)
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, AI_GATEWAY='0', TERM='xterm-256color', XDG_STATE_HOME=home)
        for name in ('AI_PROFILE', 'AI_HARNESS', 'NO_COLOR'):
            env.pop(name, None)
        env.update(overrides or {})
        os.execvpe('agent-distro', ['agent-distro'] + (args if args is not None else ['--version']), env)
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
            action = pending.pop(0)[1]
            since = len(output)
            if isinstance(action, tuple):
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', action[1], action[2], 0, 0))
            else:
                os.write(fd, action)
    else:
        os.kill(pid, 9)
        raise AssertionError(output)
    _, result = os.waitpid(pid, 0)
    os.close(fd)
    path = os.path.join(home, 'agent-distro', 'last-choice')
    choice = open(path).read().strip() if os.path.exists(path) else None
    scratch.cleanup()
    assert not pending, (pending, output)
    assert os.waitstatus_to_exitcode(result) == status, output
    drawn = ANSI.sub(b'', output)
    assert expected in drawn, (expected, output)
    return Run(output, choice)


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
assert list(listed) == ['default', 'profiles'], listed
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

# The first screen: header counts, panes, every row of the default profile.
first = run(flow(b'\r'), version(DEFAULT, NAMES[0]))
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

# Quitting chooses nothing and remembers nothing.
assert run(flow(b'q'), PROFILE_FOCUS if OTHERS else HARNESS_FOCUS).choice is None
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
numbered = ([(b'Choose a profile', b'\r')] if OTHERS else []) + [(PLAIN_PROMPT, b'\r')]
for overrides, size in [({}, (len(ROWS) + 5, 120)), ({}, (24, 20)), ({'TERM': 'dumb'}, (24, 120))]:
    small = run(numbered, version(DEFAULT, NAMES[0]), overrides, size=size)
    assert '╭'.encode() not in small.drawn, small.drawn
    assert f'1. {ROWS[0]["title"]}  {ROWS[0]["tagline"]}  {ROWS[0]["version"]}'.encode() in small.drawn, small.drawn
    assert small.choice == DEFAULT + '/' + NAMES[0], small.choice
# Growing redraws; shrinking below the minimum falls back mid-session, in the same place.
run(flow(('resize', 30, 100)) + [(HARNESS_FOCUS, b'\r')], version(DEFAULT, NAMES[0]))
shrunk = run(flow(DOWN) + [(HARNESS_FOCUS, ('resize', 6, 120)), (PLAIN_PROMPT, b'\r')], version(DEFAULT, NAMES[1]))
assert b'Choice [2]' in shrunk.drawn, shrunk.drawn

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
