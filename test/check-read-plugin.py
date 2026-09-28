"""Unit checks for lib/read-plugin.py: no VM, no harness.

Usage: check-read-plugin.py READER
"""
import importlib.util
import io
import json
import os
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True  # The reader is imported once, below.
reader = sys.argv[1]
PLUGIN = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
MCP = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
work = Path(tempfile.mkdtemp())
count = 0


def plugin(manifest=None, files=None):
    """A plugin directory; values are JSON-encoded unless they are strings."""
    global count
    count += 1
    root = work / f'p{count}'
    root.mkdir()
    if manifest is not None:
        (root / 'plugin.json').write_text(manifest if isinstance(manifest, str) else json.dumps(manifest))
    for path, content in (files or {}).items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(content if isinstance(content, str) else json.dumps(content))
    return root


def read(root):
    result = subprocess.run([sys.executable, reader, str(root)], capture_output=True, text=True)
    return result.returncode, result.stdout, result.stderr


def fatal(root, field):
    code, stdout, stderr = read(root)
    assert code == 1 and not stdout, (root, code, stdout, stderr)
    assert 'invalid Agent Plugin' in stderr and field in stderr, (field, stderr)


def ok(root):
    code, stdout, stderr = read(root)
    assert code == 0, (root, stderr)
    description = json.loads(stdout)
    # Every report is in both the description and the build log.
    assert all(r in stderr for r in description['reports']), (description, stderr)
    return description


def minimal(**fields):
    return {'$schema': PLUGIN, 'name': 'p', **fields}


def servers(mcp_servers, **extra):
    return ok(plugin(minimal(), {'mcp.json': {'$schema': MCP, 'mcpServers': mcp_servers, **extra}}))


# §5: fatal manifest violations name the field.
fatal(plugin(), 'plugin.json is missing')
fatal(plugin('{'), 'not valid JSON')
fatal(plugin([]), 'JSON object')
fatal(plugin({'name': 'p'}), '`$schema` is missing')
fatal(plugin({'$schema': PLUGIN.replace('1.0.0', '9.0.0'), 'name': 'p'}), '`$schema`')
fatal(plugin({'$schema': [PLUGIN], 'name': 'p'}), '`$schema`')
fatal(plugin({'$schema': PLUGIN}), '`name` is missing')
for name in ['My-Plugin', '-start', 'end-', 'has--double', 'too.many..dots', '', 'a' * 65, 5, None]:
    fatal(plugin(minimal(name=name)), '`name`')
for field in ['version', 'description', 'homepage', 'repository', 'license']:
    fatal(plugin(minimal(**{field: 1})), f'`{field}`')
fatal(plugin(minimal(author='someone')), '`author`')
fatal(plugin(minimal(author={'name': 'a', 'twitter': 'b'})), '`author.twitter`')
fatal(plugin(minimal(author={'email': 1})), '`author.email`')
fatal(plugin(minimal(keywords='nix')), '`keywords`')
fatal(plugin(minimal(keywords=['nix', 1])), '`keywords`')
fatal(plugin(minimal(extensions={'com.example': 1})), '`extensions.com.example`')
escaped = plugin()
(escaped / 'plugin.json').symlink_to(plugin(minimal()) / 'plugin.json')
fatal(escaped, 'outside the plugin root')

# §5.2, §8.1: unknown fields and a non-object `extensions` are only reported.
valid = ok(plugin(minimal(skills='./skills', extensions=[], author={'name': 'a'},
                          keywords=['k'], version='not semver')))
assert valid['manifest'] == minimal(author={'name': 'a'}, keywords=['k'], version='not semver'), valid
assert any('`skills`' in r for r in valid['reports']) and any('`extensions`' in r for r in valid['reports']), valid
assert ok(plugin(minimal(name='acme.tools', extensions={'com.example': {'x': [1]}})))['manifest']['extensions']

# §6.2: absent locations are not errors; the wrong kind disables one type.
empty = ok(plugin(minimal()))
assert empty['skills'] == {} and empty['mcpServers'] == {} and empty['reports'] == [], empty
wrong = ok(plugin(minimal(), {'skills': 'a file', 'mcp.json/x': 'a directory'}))
assert wrong['skills'] == {} and wrong['mcpServers'] == {} and len(wrong['reports']) == 2, wrong
outside = plugin(minimal(), {'mcp.json': {'$schema': MCP, 'mcpServers': {'s': {'type': 'stdio', 'command': 'x'}}}})
(outside / 'skills').symlink_to(plugin(None, {'s/SKILL.md': 'x'}))
split = ok(outside)
assert split['skills'] == {} and list(split['mcpServers']) == ['s'], split

# §7.1: immediate children with a regular SKILL.md; in-root links are kept,
# escaping ones skipped.
skills = plugin(minimal(), {
    'skills/a/SKILL.md': 'a', 'skills/a/scripts/run.sh': 'run',
    'skills/lower/skill.md': 'not exact', 'skills/nested/deeper/SKILL.md': 'too deep',
    'skills/dir-md/SKILL.md/x': 'a directory', 'shared/notes.md': 'shared',
    'skills/c/SKILL.md': 'c',
})
elsewhere = plugin(None, {'SKILL.md': 'outside', 'secret': 'outside'})
(skills / 'skills/a/notes.md').symlink_to('../../shared/notes.md')
(skills / 'skills/a/secret').symlink_to(elsewhere / 'secret')
(skills / 'skills/a/loop').symlink_to('.')
(skills / 'skills/a/dangling').symlink_to('missing')
(skills / 'skills/b').mkdir()
(skills / 'skills/b/SKILL.md').symlink_to(elsewhere / 'SKILL.md')
(skills / 'skills/linked').symlink_to('../shared')
(skills / 'skills/linked-skill').symlink_to('c')
found = ok(skills)
assert found['skills'] == {
    'a': ['SKILL.md', 'notes.md', 'scripts/run.sh'],
    'c': ['SKILL.md'],
    'linked-skill': ['SKILL.md'],
}, found
for label in ['skills/a/secret', 'skills/a/loop', 'skills/a/dangling', 'skills/b']:
    assert any(r.startswith(label + ':') for r in found['reports']), (label, found['reports'])

# §7.2.2: top-level problems disable MCP for the plugin only.
for config in ['{', [], {'$schema': MCP}, {'mcpServers': {}},
               {'$schema': MCP.replace('1.0.0', '9.0.0'), 'mcpServers': {}},
               {'$schema': MCP, 'mcpServers': []},
               {'$schema': MCP, 'mcpServers': {}, 'extra': 1}]:
    disabled = ok(plugin(minimal(), {'mcp.json': config, 'skills/a/SKILL.md': 'a'}))
    assert disabled['mcpServers'] == {} and list(disabled['skills']) == ['a'], (config, disabled)
    assert any('MCP disabled' in r for r in disabled['reports']), disabled
assert servers({})['mcpServers'] == {}

# §10.1: a recognized but different version disables MCP. Only 1.0.0 exists,
# so teach an in-process reader a second one.
spec = importlib.util.spec_from_file_location('read_plugin', reader)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.MCP_SCHEMAS['https://agent-plugins.org/schemas/1.1.0/mcp.schema.json'] = '1.1.0'
mismatch = plugin(minimal(), {'mcp.json': {'$schema': 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json',
                                           'mcpServers': {'s': {'type': 'stdio', 'command': 'x'}}}})
stdout, stderr = io.StringIO(), io.StringIO()
with redirect_stdout(stdout), redirect_stderr(stderr):
    assert module.main(str(mismatch)) == 0
assert json.loads(stdout.getvalue())['mcpServers'] == {} and 'plugin.json targets 1.0.0' in stderr.getvalue()

# §7.2.1, §9.2: each invalid entry is skipped alone.
invalid = {
    'no-type': {'command': 'x'},
    'bad-type': {'type': 'http', 'url': 'https://example.com'},
    'no-command': {'type': 'stdio'},
    'empty-command': {'type': 'stdio', 'command': ''},
    'parent-command': {'type': 'stdio', 'command': '../x'},
    'absolute-command': {'type': 'stdio', 'command': '/bin/sh'},
    'relative-command': {'type': 'stdio', 'command': 'bin/x'},
    'foreign-field': {'type': 'stdio', 'command': 'x', 'url': 'https://example.com'},
    'args': {'type': 'stdio', 'command': 'x', 'args': 'a'},
    'arg-type': {'type': 'stdio', 'command': 'x', 'args': [1]},
    'nul': {'type': 'stdio', 'command': 'x', 'args': ['a\0b']},
    'env': {'type': 'stdio', 'command': 'x', 'env': []},
    'env-value': {'type': 'stdio', 'command': 'x', 'env': {'A': 1}},
    'env-root': {'type': 'stdio', 'command': 'x', 'env': {'PLUGIN_ROOT': '/'}},
    'env-data': {'type': 'stdio', 'command': 'x', 'env': {'PLUGIN_DATA': '/'}},
    'env-equals': {'type': 'stdio', 'command': 'x', 'env': {'A=B': 'c'}},
    'cwd-bare': {'type': 'stdio', 'command': 'x', 'cwd': 'data'},
    'cwd-absolute': {'type': 'stdio', 'command': 'x', 'cwd': '/tmp'},
    'cwd-parent': {'type': 'stdio', 'command': 'x', 'cwd': './../..'},
    'cwd-root-parent': {'type': 'stdio', 'command': 'x', 'cwd': '${PLUGIN_ROOT}/..'},
    'cwd-prefix': {'type': 'stdio', 'command': 'x', 'cwd': '${PLUGIN_ROOT}x'},
    'cwd-link': {'type': 'stdio', 'command': 'x', 'cwd': './out'},
    'command-link': {'type': 'stdio', 'command': './out/x'},
    'no-url': {'type': 'streamable-http'},
    'stdio-field': {'type': 'sse', 'url': 'https://example.com', 'command': 'x'},
    'plain-http': {'type': 'streamable-http', 'url': 'http://example.com/mcp'},
    'plain-http-lookalike': {'type': 'streamable-http', 'url': 'http://localhost.example.com/mcp'},
    'relative-url': {'type': 'streamable-http', 'url': '/mcp'},
    'ftp': {'type': 'streamable-http', 'url': 'ftp://example.com/mcp'},
    'userinfo': {'type': 'streamable-http', 'url': 'https://user:pw@example.com/mcp'},
    'fragment': {'type': 'streamable-http', 'url': 'https://example.com/mcp#x'},
    'bad-port': {'type': 'streamable-http', 'url': 'https://example.com:99999/mcp'},
    'space-url': {'type': 'streamable-http', 'url': 'https://example.com/a b'},
    'headers': {'type': 'streamable-http', 'url': 'https://example.com', 'headers': []},
    'header-name': {'type': 'streamable-http', 'url': 'https://example.com', 'headers': {'X Y': 'z'}},
    'header-value': {'type': 'streamable-http', 'url': 'https://example.com', 'headers': {'X': 'a\r\nB: c'}},
    'header-space': {'type': 'streamable-http', 'url': 'https://example.com', 'headers': {'X': ' padded'}},
    'header-case': {'type': 'sse', 'url': 'https://example.com', 'headers': {'X-A': '1', 'x-a': '2'}},
    'not-object': 'stdio',
}
valid_servers = {
    'bare': {'type': 'stdio', 'command': 'npx', 'args': ['${PLUGIN_ROOT}/a'], 'env': {'A-B': '${HOME}'}},
    'relative': {'type': 'stdio', 'command': './bin/server', 'cwd': './bin'},
    'root-cwd': {'type': 'stdio', 'command': 'x', 'cwd': '${PLUGIN_ROOT}'},
    'data-cwd': {'type': 'stdio', 'command': 'x', 'cwd': '${PLUGIN_DATA}/sub/../..'},
    'localhost': {'type': 'streamable-http', 'url': 'http://localhost:8080/mcp'},
    'loopback': {'type': 'sse', 'url': 'http://127.0.0.2/sse'},
    'loopback6': {'type': 'streamable-http', 'url': 'http://[::1]:1/mcp'},
    'remote': {'type': 'streamable-http', 'url': 'https://example.com/mcp', 'headers': {'X-Tenant': 'a b'}},
}
root = plugin(minimal(), {'bin/server': '', 'mcp.json': {'$schema': MCP, 'mcpServers': invalid | valid_servers}})
(root / 'out').symlink_to(work)
loaded = ok(root)
assert set(loaded['mcpServers']) == set(valid_servers), set(loaded['mcpServers']) ^ set(valid_servers)
for name in invalid:
    assert any(r.startswith(f'mcp.json: server "{name}" skipped') for r in loaded['reports']), name
assert loaded['mcpServers']['bare'] == {**valid_servers['bare']}, loaded
assert loaded['mcpServers']['relative'] == {**valid_servers['relative'], 'args': [], 'env': {}, 'cwdBase': 'root'}
# PLUGIN_DATA containment is only known at launch; the launcher checks it.
assert loaded['mcpServers']['data-cwd']['cwdBase'] == 'data'
assert loaded['mcpServers']['remote']['headers'] == {'X-Tenant': 'a b'}

print('read-plugin: all checks passed')
