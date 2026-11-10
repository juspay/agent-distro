"""Read discovery from the real Claude launcher, without authentication or a model."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading

expected = json.loads(sys.argv[1])
home = Path.home()
# Where a launch's translations live: the adapter translates at launch, by
# content, under this root (src/plugin/launch.ts), never into the store.
translations = Path(os.environ.get('XDG_CACHE_HOME') or home / '.cache') / 'agent-distro' / 'plugins'
config_dir = home / 'relocated-claude'
config_dir.mkdir()
env = dict(os.environ, CLAUDE_CONFIG_DIR=str(config_dir))
for key in ['LITELLM_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']:
    env.pop(key, None)

settings = config_dir / 'settings.json'
settings.write_text('{"model":"sonnet","env":{"PERSONAL_SETTING":"keep"}}\n')
credentials = config_dir / '.credentials.json'
credentials.write_text('{}\n')
session = config_dir / 'projects' / 'keep.jsonl'
session.parent.mkdir()
session.write_text('session sentinel\n')
preserved = {path: path.read_bytes() for path in [settings, credentials, session]}


def run(*args, launcher='claude', plugins=None):
    # `plugins` is AGENT_DISTRO_PLUGINS for this launch only.
    extra = {} if plugins is None else {'AGENT_DISTRO_PLUGINS': plugins}
    return subprocess.run([launcher, *args], env=env | extra, text=True,
                          capture_output=True, timeout=60, check=True).stdout


def inventory(plugin, launcher='claude', plugins=None):
    # Claude's own inventory, rather than inspecting the translated files.
    details = run('plugin', 'details', plugin, launcher=launcher, plugins=plugins)
    # An MCP-only plugin prints `Skills (0)` with no names after it.
    match = re.search(r'^\s*Skills \((\d+)\)[ \t]*([^\n]*)', details, re.MULTILINE)
    assert match, details
    names = set(filter(None, match[2].split(', ')))
    assert len(names) == int(match[1]), details
    return names, details


# A model endpoint of our own, and what the launches below sent it: a session
# asks for things no listing shows, and this is where those are read, without
# credentials, a network or a model.
sent: list[str] = []
endpoint = None


class Endpoint(BaseHTTPRequestHandler):
    def log_message(self, *arguments):
        pass

    def reply(self, content_type, body):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply('application/json', b'{"data":[]}')

    def do_POST(self):
        sent.append(self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode())
        message = {'id': 'fixture', 'type': 'message', 'role': 'assistant', 'model': 'fixture',
                   'content': [], 'stop_reason': None, 'stop_sequence': None,
                   'usage': {'input_tokens': 1, 'output_tokens': 1}}
        events = [
            ('message_start', {'type': 'message_start', 'message': message}),
            ('content_block_start', {'type': 'content_block_start', 'index': 0,
                                     'content_block': {'type': 'text', 'text': ''}}),
            ('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                                     'delta': {'type': 'text_delta', 'text': 'ok'}}),
            ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
            ('message_delta', {'type': 'message_delta', 'usage': {'output_tokens': 1},
                               'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}}),
            ('message_stop', {'type': 'message_stop'}),
        ]
        self.reply('text/event-stream', ''.join(
            f'event: {name}\ndata: {json.dumps(payload)}\n\n' for name, payload in events).encode())


def prompt(cwd, *args, launcher='claude'):
    """What one non-interactive turn, launched in `cwd`, asks the model for."""
    global endpoint
    if endpoint is None:
        endpoint = ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
        threading.Thread(target=endpoint.serve_forever, daemon=True).start()
    sent.clear()
    subprocess.run([launcher, '-p', 'say ok', *args], cwd=cwd, text=True, capture_output=True,
                   timeout=180, check=True,
                   env=env | {'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{endpoint.server_address[1]}',
                              'ANTHROPIC_API_KEY': 'test-api-key', 'DISABLE_TELEMETRY': '1',
                              'DISABLE_ERROR_REPORTING': '1', 'DISABLE_NON_ESSENTIAL_MODEL_CALLS': '1'})
    assert sent, 'the launch sent the endpoint nothing'
    return '\n'.join(sent)


def checkout(name, skill):
    """A plugin working copy outside the store, as a user edits one."""
    root = home / 'checkouts' / name
    (root / 'skills' / skill).mkdir(parents=True)
    (root / 'plugin.json').write_text(json.dumps({
        '$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'name': name}))
    (root / 'skills' / skill / 'SKILL.md').write_text(f'---\nname: {skill}\ndescription: {skill}\n---\n')
    return str(root)
