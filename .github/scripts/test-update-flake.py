"""Check release policy and reporting offline, without opening a PR."""
import json
import os
from itertools import product
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent


def write_pins(root, profile, pins):
    """Lay out a profiles/<profile>/npins/sources.json the way npins does."""
    sources = root / 'profiles' / profile / 'npins' / 'sources.json'
    sources.parent.mkdir(parents=True)
    sources.write_text(json.dumps({
        'pins': {name: {'type': 'Git', 'revision': revision} for name, revision in pins.items()},
        'version': 8,
    }))


class UpdateFlakeTests(unittest.TestCase):
    def test_read_versions_prints_and_appends_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            nix = root / 'nix'
            nix.write_text('#!/bin/sh\n'
                           '[ "$1" = eval ] && [ "$2" = --raw ] || exit 1\n'
                           'case "$3" in\n'
                           '  .#default.harnesses.codex.version) printf 0.153.0 ;;\n'
                           '  .#default.harnesses.claude.version) printf 2.1.273 ;;\n'
                           '  *) exit 1 ;;\n'
                           'esac\n')
            nix.chmod(0o755)
            write_pins(root, 'juspay', {'skills': 'a' * 40, 'kolu': 'b' * 40})
            output = root / 'outputs'
            output.write_text('existing=value\n')
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}',
                       GITHUB_OUTPUT=str(output))
            result = subprocess.run(['bash', str(SCRIPTS / 'read-versions.sh')],
                                    cwd=root, env=env, capture_output=True, text=True)
            expected = ('codex-version=0.153.0\nclaude-version=2.1.273\n'
                        'plugins={"juspay/kolu": "%s", "juspay/skills": "%s"}\n' % ('b' * 40, 'a' * 40))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, expected)
            self.assertEqual(output.read_text(), 'existing=value\n' + expected)

    def test_plugin_pins_are_read_per_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pins(root, 'juspay', {'skills': 'a' * 40})
            write_pins(root, 'other', {'skills': 'c' * 40})
            # A profile without pins contributes nothing and must not fail.
            (root / 'profiles' / 'vanilla').mkdir()
            result = subprocess.run(['python3', str(SCRIPTS / 'read-plugin-pins.py')],
                                    cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout),
                             {'juspay/skills': 'a' * 40, 'other/skills': 'c' * 40})

    def test_omp_pin_moves_only_forward(self):
        cases = [
            ('v18.2.4', 'v18.2.5', 'v18.2.5'),
            ('v18.2.9', 'v18.2.10', 'v18.2.10'),
            ('v18.2.4', 'v18.2.4', 'v18.2.4'),
            ('v18.2.4', 'v18.2.3', 'v18.2.4'),
            ('v18.2.4', 'invalid', None),
            ('v18.2.4', '', None),
            ('missing', 'v18.2.5', None),
        ]
        for before, latest, after in cases:
            with self.subTest(before=before, latest=latest), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                flake = root / 'flake.nix'
                original = f'oh-my-pi.url = "github:can1357/oh-my-pi/{before}";\n'
                flake.write_text(original)
                gh = root / 'gh'
                gh.write_text('#!/bin/sh\nprintf "%s\\n" "$TEST_LATEST"\n')
                gh.chmod(0o755)
                output = root / 'outputs'
                env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}',
                           TEST_LATEST=latest, GITHUB_OUTPUT=str(output))
                result = subprocess.run(['bash', str(SCRIPTS / 'advance-omp-pin.sh')],
                                        cwd=root, env=env, capture_output=True, text=True)
                if after is None:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(flake.read_text(), original)
                    self.assertFalse(output.exists())
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(flake.read_text(), original.replace(before, after))
                    self.assertEqual(output.read_text(), f'before={before}\nafter={after}\nlatest={latest}\n')

    def report(self, root, **overrides):
        (root / 'flake-update.log').write_text('skills revision changed\n')
        env = dict(os.environ, OMP_BEFORE='v18.2.4', OMP_AFTER='v18.2.4', OMP_LATEST='v18.2.3',
                   CODEX_BEFORE='0.153.0', CODEX_AFTER='0.153.0',
                   CLAUDE_BEFORE='2.1.273', CLAUDE_AFTER='2.1.273',
                   PLUGINS_BEFORE='{}', PLUGINS_AFTER='{}',
                   GITHUB_SERVER_URL='https://github.com', GITHUB_REPOSITORY='juspay/agent-distro',
                   GITHUB_RUN_ID='123', RUNNER_TEMP=str(root), GITHUB_OUTPUT=str(root / 'outputs'))
        env.update(overrides)
        subprocess.run(['python3', str(SCRIPTS / 'describe-flake-update.py')], env=env, check=True)
        outputs = dict(line.split('=', 1) for line in (root / 'outputs').read_text().splitlines())
        return outputs, Path(outputs['pr-body-path']).read_text()

    def test_report_uses_resolved_versions_and_preserves_lock_log(self):
        for omp_changed, codex_changed, claude_changed in product([False, True], repeat=3):
            with self.subTest(omp=omp_changed, codex=codex_changed, claude=claude_changed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                outputs, body = self.report(
                    root,
                    OMP_AFTER='v18.2.5' if omp_changed else 'v18.2.4',
                    OMP_LATEST='v18.2.5' if omp_changed else 'v18.2.3',
                    CODEX_AFTER='0.154.0' if codex_changed else '0.153.0',
                    CLAUDE_AFTER='2.1.274' if claude_changed else '2.1.273')
                self.assertIn('skills revision changed', body)
                self.assertIn('https://github.com/juspay/agent-distro/actions/runs/123', body)
                self.assertEqual('oh-my-pi v18.2.4 → v18.2.5' in outputs['pr-title'], omp_changed)
                self.assertEqual('Codex 0.153.0 → 0.154.0' in outputs['pr-title'], codex_changed)
                self.assertEqual('Claude Code 2.1.273 → 2.1.274' in outputs['pr-title'], claude_changed)
                if claude_changed:
                    self.assertIn('/releases/tag/v2.1.274', body)
                else:
                    self.assertIn('Claude Code unchanged (`2.1.273`)', body)
                if codex_changed:
                    self.assertIn('/releases/tag/rust-v0.154.0', body)
                else:
                    self.assertIn('Codex unchanged (`0.153.0`)', body)
                if not omp_changed:
                    self.assertIn('the pin only moves forward', body)

    def test_report_names_plugin_revisions_by_short_rev(self):
        moved, same, added = 'a' * 40, 'b' * 40, 'c' * 40
        with tempfile.TemporaryDirectory() as directory:
            outputs, body = self.report(
                Path(directory),
                PLUGINS_BEFORE=json.dumps({'juspay/skills': moved, 'juspay/kolu': same, 'juspay/gone': 'd' * 40}),
                PLUGINS_AFTER=json.dumps({'juspay/skills': added, 'juspay/kolu': same, 'juspay/new': added}))
            self.assertIn(f'juspay/skills {moved[:7]} → {added[:7]}', outputs['pr-title'])
            self.assertIn('juspay/gone removed', outputs['pr-title'])
            self.assertIn(f'juspay/new {added[:7]}', outputs['pr-title'])
            self.assertNotIn('juspay/kolu', outputs['pr-title'])
            self.assertIn(f'- `juspay/skills` `{moved[:7]}` → `{added[:7]}`', body)
            self.assertIn(f'- `juspay/kolu` unchanged (`{same[:7]}`)', body)
            self.assertIn(f'- `juspay/new` pinned at `{added[:7]}`', body)

    def test_report_survives_a_registry_with_no_pins(self):
        with tempfile.TemporaryDirectory() as directory:
            outputs, body = self.report(Path(directory))
            self.assertIn('No plugin sources are pinned', body)
            self.assertEqual(outputs['pr-title'], 'chore(flake): update inputs')


if __name__ == '__main__':
    unittest.main()
