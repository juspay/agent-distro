import os
import pty
import select
import time


def choose(harness, expected, overrides=None, command='ai', status=0):
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, AI_GATEWAY='0')
        env.pop('AI_PROFILE', None)
        env.pop('AI_HARNESS', None)
        env.update(overrides or {})
        os.execvpe(command, [command, '--version'], env)
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
        if harness is not None and b'Agent [1/2/3]' in output:
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


choose(b'2\n', b'codex-cli')
choose(b'3\n', b'(Claude Code)')
choose(b'wrong\n1\n', b'Enter 1 for Oh My Pi')
choose(None, b'codex-cli', {'AI_HARNESS': 'codex'})
choose(None, b'valid values: omp, codex, claude', {'AI_HARNESS': 'bad'}, status=1)
choose(b'\x04', b'Choose a coding agent', status=1)
output = choose(b'q\n', b'Choose a coding agent')
import sys
assert (b'uses its own login' in output) == (sys.argv[1] == 'gateway'), output
