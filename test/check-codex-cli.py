"""Keep session defaults tied to Codex help and verify argument forwarding."""
import re

from codex_support import *


def check_contract():
    prelude = Path(os.environ['CODEX_SESSION_DEFAULTS']).read_text()
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
    interactive = {'resume', 'fork'}
    assert commands | aliases == (tools - hidden - platform_only) | interactive, (
        'Codex command grammar drift', commands | aliases, tools)

    values = set()
    for line in help_text.splitlines():
        if re.match(r'^\s+(?:-[A-Za-z], )?--[\w-]+\s+<', line):
            values.update(re.findall(r'(?<!\w)--?[A-Za-z][\w-]*', line.split('<', 1)[0]))
    value_pattern = re.search(r'^\s+(--config\|-c\|[^\n]+)\)\n', prelude, re.M)[1]
    # --remote takes a value but bypasses the session defaults altogether.
    assert values == set(value_pattern.split('|')) | {'--remote'}, (
        'Codex value-flag grammar drift', values, value_pattern)


check_contract()
for arguments, inject in [
    ([], True),
    (['hello'], True),
    (['resume', '--last'], True),
    (['fork', '--last'], True),
    (['--', 'hello'], True),
    (['-c', 'model="my-model"', 'resume'], True),
    (['--model', 'exec', 'hello'], True),
    (['--no-daemon'], False),
    (['resume', '--no-daemon'], False),
    (['--remote', 'unix://'], False),
    (['--remote=unix://'], False),
    (['--help'], False),
    (['--version'], False),
    (['exec', 'hello'], False),
    (['agents'], False),
    (['-c', 'model="my-model"', 'app-server', 'daemon', 'version'], False),
    (['plugin', 'list', '--json'], False),
]:
    result = subprocess.run(
        ['bash', '-euo', 'pipefail', '-c',
         'source "$CODEX_SESSION_DEFAULTS"; printf "%s\\0" "$@"',
         'fixture', *arguments], env=env, capture_output=True, check=True)
    forwarded = result.stdout.decode().split('\0')[:-1]
    assert forwarded == (['--no-daemon'] if inject else []) + arguments, (arguments, forwarded)
assert_preserved()
