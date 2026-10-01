"""Exercise reporting with invented harnesses: no production inventory here."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent


class UpdateFlakeTests(unittest.TestCase):
    def test_versions_are_one_json_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            nix = root / 'nix'
            nix.write_text('#!/bin/sh\n'
                           '[ "$1" = eval ] && [ "$2" = --json ] || exit 1\n'
                           '[ "$3" = ".#harnesses.x86_64-linux" ] || exit 1\n'
                           '[ "$4" = --apply ] || exit 1\n'
                           '[ "$5" = "builtins.mapAttrs (_: p: p.version)" ] || exit 1\n'
                           'echo call >> calls\n'
                           'echo \'{"new-agent":"3.0","another":"2.1"}\'\n')
            nix.chmod(0o755)
            result = subprocess.run(['bash', str(SCRIPTS / 'read-versions.sh')],
                                    cwd=root, env=dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}'),
                                    capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout), {'new-agent': '3.0', 'another': '2.1'})
            self.assertEqual((root / 'calls').read_text(), 'call\n')

    def test_all_pin_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for folder, pin in [('profiles/team', {'type': 'Git', 'revision': 'a' * 40}),
                                ('harnesses/new-agent', {'type': 'GitRelease', 'version': 'v3',
                                                        'repository': {'type': 'GitHub', 'owner': 'example', 'repo': 'agent'}}),
                                ('lib', {'type': 'Git', 'revision': 'b' * 40})]:
                path = root / folder / 'npins/sources.json'
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps({'pins': {'source': pin}, 'version': 8}))
            result = subprocess.check_output(['python3', str(SCRIPTS / 'read-pins.py')], cwd=root, text=True)
            self.assertEqual(json.loads(result), {
                'team/source': {'at': 'aaaaaaa'}, 'lib/source': {'at': 'bbbbbbb'},
                'new-agent/source': {'at': 'v3', 'notes': 'https://github.com/example/agent/releases/tag/v3'}})

    def test_report_discovers_orders_and_links_harnesses(self):
        for changed in [False, True]:
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'flake-update.log').write_text('lock moved\n')
                before = {'z-first': '1.0', 'a-second': '2.0'}
                after = dict(before, **{'z-first': '1.1' if changed else '1.0', 'new': '3.0'})
                metadata = {name: {'title': title, 'order': order, 'releaseNotes': f'https://example.invalid/{name}/{after[name]}'}
                            for name, title, order in [('z-first', 'First', 0), ('a-second', 'Second', 1), ('new', 'New', 2)]}
                env = dict(os.environ, VERSIONS_BEFORE=json.dumps(before), VERSIONS_AFTER=json.dumps(after),
                           HARNESS_META=json.dumps(metadata), PINS_BEFORE='{"team/source":{"at":"aaaaaaa"}}',
                           PINS_AFTER='{"team/source":{"at":"bbbbbbb"}}',
                           GITHUB_SERVER_URL='https://github.com', GITHUB_REPOSITORY='example/distro',
                           GITHUB_RUN_ID='123', RUNNER_TEMP=str(root), GITHUB_OUTPUT=str(root / 'outputs'))
                subprocess.run(['python3', str(SCRIPTS / 'describe-flake-update.py')], env=env, check=True)
                outputs = dict(line.split('=', 1) for line in (root / 'outputs').read_text().splitlines())
                body = Path(outputs['pr-body-path']).read_text()
                self.assertLess(body.index('**First'), body.index('**Second'))
                self.assertLess(body.index('**Second'), body.index('**New'))
                self.assertEqual('First 1.0 → 1.1' in outputs['pr-title'], changed)
                self.assertIn('New added → 3.0', outputs['pr-title'])
                self.assertIn('https://example.invalid/new/3.0', body)
                self.assertIn('team/source aaaaaaa → bbbbbbb', outputs['pr-title'])
                self.assertIn('lock moved', body)
                self.assertIn('https://github.com/example/distro/actions/runs/123', body)


if __name__ == '__main__':
    unittest.main()
