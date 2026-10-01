"""Probe the real OMP ACP session and process environment without model calls."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

expected = json.loads(sys.argv[1])
expected_skills = {skill for skills in expected.values() for skill in skills}


def discover(launcher='omp', env=None):
    with tempfile.TemporaryDirectory() as cwd, tempfile.TemporaryFile(mode='w+') as output:
        process = subprocess.Popen([launcher, 'acp'], cwd=cwd, env=env,
                                   stdin=subprocess.PIPE, stdout=output,
                                   stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                'params': {'protocolVersion': 1, 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}}}}) + '\n')
            process.stdin.flush()
            def wait_for_response(request_id):
                deadline = time.monotonic() + 120
                messages = []
                while time.monotonic() < deadline:
                    # Ignore a partial final line while the child is writing it.
                    data = os.pread(output.fileno(), os.fstat(output.fileno()).st_size, 0)
                    lines = data.splitlines(keepends=True)
                    messages = [json.loads(line) for line in lines
                                if line.endswith(b'\n') and line.strip()]
                    assert process.poll() is None, (process.returncode, messages)
                    responses = [m for m in messages if m.get('id') == request_id]
                    # OMP deliberately sends command discovery after session/new.
                    commands_ready = any(
                        m.get('method') == 'session/update' and
                        m.get('params', {}).get('update', {}).get('sessionUpdate') ==
                        'available_commands_update' for m in messages)
                    if responses and (request_id != 2 or commands_ready or
                                      'error' in responses[0]):
                        return messages
                    time.sleep(0.1)
                raise AssertionError(('ACP response timed out', request_id, messages))

            initialized = wait_for_response(1)
            assert any(m.get('id') == 1 and 'result' in m for m in initialized), initialized
            environ = Path(f'/proc/{process.pid}/environ').read_bytes().split(b'\0')
            process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'session/new',
                'params': {'cwd': cwd, 'mcpServers': []}}) + '\n')
            process.stdin.flush()
            messages = wait_for_response(2)
            assert any(m.get('id') == 2 and 'result' in m for m in messages), messages
            skills = set(re.findall(r'"name":\s*"skill:([^"]+)"', json.dumps(messages)))
            assert skills == expected_skills, (skills, expected_skills, messages)
            return environ
        finally:
            process.terminate()
            process.communicate(timeout=10)
