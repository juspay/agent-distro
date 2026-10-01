"""Adapter policy checks without starting OpenCode or reaching a gateway."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ADAPTER = Path(sys.argv.pop())
from gateway_models import main as cache_config


class AdapterTests(unittest.TestCase):
    schema = "v1"

    provider_key = "provider"
    settings_key = "options"

    def test_server_names_and_collisions(self):
        local = {'type': 'stdio', 'command': 'echo', 'args': [], 'env': {}}
        remote = {'type': 'streamable-http', 'url': 'https://example.com/mcp', 'headers': {}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gateway = root / 'gateway.json'
            gateway.write_text('null')

            def description(plugin, server):
                path = root / f'{plugin}.json'
                path.write_text(json.dumps({
                    'version': '1.0.0', 'root': str(root), 'manifest': {'name': plugin},
                    'skills': {}, 'mcpServers': {'shared': server},
                }))
                return str(path)

            def generate(out, *descriptions):
                return subprocess.run(
                    [sys.executable, str(ADAPTER / 'write-config.py'), self.schema, str(out),
                     '/bin/sh', '/usr/bin/env', str(gateway), *descriptions],
                    capture_output=True, text=True)

            first = description('first-plugin', local)
            out = root / 'valid'
            result = generate(out, first)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = json.loads((out / 'opencode.json').read_text())
            servers = config['mcp']['servers'] if self.schema == 'v2' else config['mcp']
            self.assertEqual(set(servers), {'shared'})
            self.assertEqual(config['skills'], [] if self.schema == 'v2' else {'paths': []})
            for server in [local, remote]:
                second = description('second-plugin', server)
                for index, order in enumerate([(first, second), (second, first)]):
                    with self.subTest(type=server['type'], order=index):
                        result = generate(root / f'collision-{server["type"]}-{index}', *order)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('MCP server "shared"', result.stderr)
                        self.assertIn('"first-plugin"', result.stderr)
                        self.assertIn('"second-plugin"', result.stderr)

    def test_credentials_and_fallbacks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base, cache = root / 'base.json', root / 'cache/opencode.json'
            provider = {
                self.settings_key: {'baseURL': 'https://gateway.example/v1'},
                'models': {'large': {'name': 'large'}, 'small': {'name': 'small'}},
            }
            if self.schema == 'v2':
                provider['env'] = ['TEST_KEY']
            else:
                provider['options']['apiKey'] = '{env:TEST_KEY}'
            base.write_text(json.dumps({self.provider_key: {'litellm': provider}}))
            key = 'test"key\\value'

            def fetch(argv, **kwargs):
                self.assertNotIn(key, ' '.join(argv))
                self.assertNotIn('--header', argv)
                self.assertEqual(argv[argv.index('--config') + 1], '-')
                self.assertEqual(kwargs['input'], 'header = "Authorization: Bearer test\\"key\\\\value"\n')
                return subprocess.CompletedProcess(argv, 0, '{"data":[{"id":"served"}]}')

            def invoke():
                stdout, stderr = io.StringIO(), io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr), patch.dict(os.environ, TEST_KEY=key):
                    cache_config(str(base), str(cache), 'curl', 'TEST_KEY', json.loads((ADAPTER.parent / ('opencode2' if self.schema == 'v2' else 'opencode') / 'gateway-shape.json').read_text()))
                return stdout.getvalue().strip(), stderr.getvalue()

            with patch('subprocess.run', side_effect=fetch):
                selected, warning = invoke()
            self.assertEqual(selected, str(cache))
            self.assertEqual(warning, '')
            saved = cache.read_bytes()
            self.assertNotIn(key.encode(), saved)
            self.assertEqual(set(json.loads(saved)[self.provider_key]['litellm']['models']),
                             {'served', 'large', 'small'})

            with patch('subprocess.run', side_effect=OSError('unreachable')):
                selected, warning = invoke()
                self.assertEqual(selected, str(cache))
                self.assertIn(f'cached model list from {cache}', warning)
                self.assertEqual(len(warning.splitlines()), 1)
                self.assertNotIn(key, warning)
                self.assertEqual(cache.read_bytes(), saved)
                cache.unlink()
                selected, warning = invoke()
                self.assertEqual(selected, str(base))
                self.assertIn(f'two profile aliases from {base}', warning)
                self.assertEqual(len(warning.splitlines()), 1)

    def test_gateway_and_materialized_skills(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'skills/guide'
            source.mkdir(parents=True)
            (source / 'SKILL.md').write_text('---\nname: guide\ndescription: Guide\n---\nRead me.\n')
            gateway = root / 'gateway.json'
            gateway.write_text(json.dumps({'url': 'https://gateway.example/', 'keyEnv': 'TEST_KEY',
                                           'models': {'large': 'large', 'small': 'small'}}))
            description = root / 'plugin.json'
            description.write_text(json.dumps({
                'root': str(root), 'manifest': {'name': 'example'},
                'skills': {'guide': ['SKILL.md']},
                'mcpServers': {'remote': {'type': 'streamable-http', 'url': 'https://example.com/mcp',
                                          'headers': {'Authorization': 'Bearer {env:TOKEN}'}}},
            }))
            out = root / 'out'
            subprocess.run([sys.executable, str(ADAPTER / 'write-config.py'), self.schema,
                            str(out), '/bin/sh', '/usr/bin/env', str(gateway), str(description)], check=True)
            plain = json.loads((out / 'opencode.json').read_text())
            self.assertNotIn(self.provider_key, plain)
            paths = plain['skills'] if self.schema == 'v2' else plain['skills']['paths']
            self.assertEqual(paths, [str(out / 'skills/example')])
            self.assertEqual((Path(paths[0]) / 'guide/SKILL.md').read_text(), (source / 'SKILL.md').read_text())
            servers = plain['mcp']['servers'] if self.schema == 'v2' else plain['mcp']
            self.assertEqual(servers['remote']['type'], 'remote')
            config = json.loads((out / 'gateway.json').read_text())
            provider = config[self.provider_key]['litellm']
            self.assertEqual(set(provider['models']), {'large', 'small'})
            self.assertEqual(provider[self.settings_key]['baseURL'], 'https://gateway.example/v1')
            self.assertEqual(config['model'], 'litellm/large')
            if self.schema == 'v2':
                self.assertEqual(provider['env'], ['TEST_KEY'])
                self.assertEqual(provider['package'], '@opencode/ai/providers/openai-compatible')
                self.assertNotIn('small_model', config)
                self.assertNotIn('provider', config)
                self.assertNotIn('apiKey', provider['settings'])
            else:
                self.assertEqual(provider['npm'], '@ai-sdk/openai-compatible')
                self.assertEqual(provider['options']['apiKey'], '{env:TEST_KEY}')
                self.assertEqual(config['small_model'], 'litellm/small')


class AdapterV2Tests(AdapterTests):
    schema = 'v2'
    provider_key = 'providers'
    settings_key = 'settings'


if __name__ == '__main__':
    unittest.main()
