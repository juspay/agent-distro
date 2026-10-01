"""Pi translation boundaries that do not require a running harness."""
from contextlib import redirect_stderr
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest

ADAPTER = Path(sys.argv.pop())
write_config = runpy.run_path(str(ADAPTER / 'write-config.py'))['main']
merge = runpy.run_path(str(ADAPTER / 'merge-state.py'))['main']


class PiAdapterTests(unittest.TestCase):
    def test_translation_and_skipped_transports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'skills/guide').mkdir(parents=True)
            (root / 'skills/guide/SKILL.md').write_text('Guide')
            (root / 'skills/guide/approved').symlink_to('SKILL.md')
            (root / 'skills/guide/unapproved').write_text('Do not copy')
            description = root / 'description.json'
            description.write_text(json.dumps({
                'version': '1.0.0', 'root': str(root), 'manifest': {'name': 'example'},
                'skills': {'guide': ['SKILL.md', 'approved']},
                'mcpServers': {
                    'local': {'type': 'stdio', 'command': './server', 'args': [], 'env': {}},
                    'http': {'type': 'streamable-http', 'url': 'https://example.test/mcp', 'headers': {}},
                    'sse': {'type': 'sse', 'url': 'https://example.test/sse', 'headers': {}},
                    'equals': {'type': 'stdio', 'command': 'bad=command', 'args': [], 'env': {}},
                },
            }))
            gateway = root / 'gateway.json'
            gateway.write_text(json.dumps({'url': 'https://gateway.test/', 'keyEnv': 'TEST_KEY',
                                           'models': {'large': 'large', 'small': 'small'}}))
            out = root / 'out-pi-config'
            diagnostics = io.StringIO()
            with redirect_stderr(diagnostics):
                write_config(str(out), '/bin/sh', '/usr/bin/env', str(gateway), str(description))
            config = json.loads((out / 'config.json').read_text())
            self.assertEqual(set(config['mcpServers']), {'local', 'http'})
            self.assertIn('Pi does not support SSE', diagnostics.getvalue())
            self.assertIn('command containing "="', diagnostics.getvalue())
            local = config['mcpServers']['local']
            self.assertEqual(set(local), {'command'})
            self.assertIn('PLUGIN_ROOT=', Path(local['command']).read_text())
            skills = Path(config['skills'][0]) / 'guide'
            self.assertFalse((skills / 'approved').is_symlink())
            self.assertEqual((skills / 'approved').read_text(), 'Guide')
            self.assertFalse((skills / 'unapproved').exists())
            provider = json.loads((out / 'gateway.json').read_text())['providers']['litellm']
            self.assertEqual(provider['apiKey'], '$TEST_KEY')
            self.assertEqual(provider['baseUrl'], 'https://gateway.test/v1')
            self.assertEqual(provider['models'], [{'id': 'large'}, {'id': 'small'}])
            with self.assertRaisesRegex(SystemExit, 'declared by both'):
                write_config(str(root / 'collision'), '/bin/sh', '/usr/bin/env', str(gateway),
                             str(description), str(description))

    def test_empty_contributions_leave_files_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fragment = root / 'fragment.json'
            fragment.write_text(json.dumps({'skills': [], 'mcpServers': {}}))
            agent = root / 'agent'
            for mode in ['--check', '--merge']:
                merge(mode, str(agent), str(fragment))
                self.assertFalse(agent.exists())
            agent.mkdir()
            for name, content in [('mcp', '{}'), ('settings', '{"theme": "light"}')]:
                (agent / f'{name}.json').write_text(content)
            before = {path: (path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns)
                      for path in agent.iterdir()}
            for mode in ['--check', '--merge']:
                merge(mode, str(agent), str(fragment))
                for path, original in before.items():
                    self.assertEqual((path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns), original)
            (agent / 'settings.json').write_text(json.dumps({
                'skills': ['/personal/skills', '/nix/store/old-pi-config/skills/example']}))
            merge('--merge', str(agent), str(fragment))
            self.assertEqual(json.loads((agent / 'settings.json').read_text()), {'skills': ['/personal/skills']})
            (agent / 'settings.json').write_text('{')
            with self.assertRaises(ValueError):
                merge('--merge', str(agent), str(fragment))
            self.assertEqual((agent / 'settings.json').read_text(), '{')

    def test_only_contributing_files_are_created(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fragment = root / 'fragment.json'
            for name, contribution in [('settings', {'skills': ['/managed/skills'], 'mcpServers': {}}),
                                       ('mcp', {'skills': [], 'mcpServers': {'managed': {'command': '/server'}}})]:
                fragment.write_text(json.dumps(contribution))
                agent = root / name
                merge('--merge', str(agent), str(fragment))
                self.assertEqual([path.name for path in agent.iterdir()], [f'{name}.json'])

    def test_atomic_preservation_and_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fragment = root / 'fragment.json'
            fragment.write_text(json.dumps({'skills': ['/nix/store/new-pi-config/skills/example'],
                'mcpServers': {'managed': {'command': '/new/server'}}}))
            mcp = root / 'mcp.json'
            mcp.write_text(json.dumps({'mcpServers': {'personal': {'command': '/personal'},
                                                   'managed': {'command': '/old/server'}}}))
            mcp.chmod(0o640)
            settings = root / 'settings.json'
            settings.write_text(json.dumps({'skills': ['/personal/skills', '/nix/store/old-pi-config/skills/example'],
                                            'theme': 'light'}))
            before = mcp.stat().st_ino
            merge('--merge', directory, str(fragment))
            self.assertNotEqual(mcp.stat().st_ino, before)
            self.assertEqual(mcp.stat().st_mode & 0o777, 0o640)
            self.assertEqual(json.loads(mcp.read_text())['mcpServers'], {
                'personal': {'command': '/personal'}, 'managed': {'command': '/new/server'}})
            self.assertEqual(json.loads(settings.read_text()), {
                'skills': ['/personal/skills', '/nix/store/new-pi-config/skills/example'], 'theme': 'light'})
            inode = mcp.stat().st_ino
            merge('--merge', directory, str(fragment))
            self.assertEqual(mcp.stat().st_ino, inode)
            before = mcp.read_bytes()
            settings.write_text('{')
            with self.assertRaises(ValueError):
                merge('--merge', directory, str(fragment))
            self.assertEqual(mcp.read_bytes(), before)
            self.assertEqual(settings.read_text(), '{')
            self.assertFalse(list(root.glob('.pi-*')))


if __name__ == '__main__':
    unittest.main()
