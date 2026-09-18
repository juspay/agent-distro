"""Probe the real OMP ACP session and process environment without model calls."""
import json
import os
from pathlib import Path
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
            time.sleep(3)
            assert process.poll() is None
            environ = Path(f'/proc/{process.pid}/environ').read_bytes().split(b'\0')
            process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'session/new',
                'params': {'cwd': cwd, 'mcpServers': []}}) + '\n')
            process.stdin.flush()
            time.sleep(10)
            output.seek(0)
            messages = [json.loads(line) for line in output if line.strip()]
            assert any(m.get('id') == 2 and 'result' in m for m in messages), messages
            import re
            skills = set(re.findall(r'"name":\s*"skill:([^"]+)"', json.dumps(messages)))
            assert skills == expected_skills, (skills, expected_skills, messages)
            return environ
        finally:
            process.terminate()
            process.communicate(timeout=10)
