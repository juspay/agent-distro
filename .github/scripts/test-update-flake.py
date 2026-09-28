"""Check release policy and reporting offline, without opening a PR."""
import json
import os
from itertools import product
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent


def release(owner, repo, version):
    """A pin on a release, the way npins records one."""
    return {'type': 'GitRelease', 'version': version, 'revision': 'd' * 40,
            'repository': {'type': 'GitHub', 'owner': owner, 'repo': repo}}


def write_pins(root, profile, pins):
    """Lay out a profiles/<profile>/npins/sources.json the way npins does.

    A pin given as a revision follows a branch; `release` gives the other kind.
    """
    sources = root / 'profiles' / profile / 'npins' / 'sources.json'
    sources.parent.mkdir(parents=True)
    sources.write_text(json.dumps({
        'pins': {name: pin if isinstance(pin, dict) else {'type': 'Git', 'revision': pin}
                 for name, pin in pins.items()},
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
                           '  .#harnesses.x86_64-linux.codex.version) printf 0.153.0 ;;\n'
                           '  .#harnesses.x86_64-linux.claude.version) printf 2.1.273 ;;\n'
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
                        'pins={"juspay/kolu": {"at": "bbbbbbb"}, "juspay/skills": {"at": "aaaaaaa"}}\n')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, expected)
            self.assertEqual(output.read_text(), 'existing=value\n' + expected)

    def test_pins_are_read_per_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pins(root, 'juspay', {'skills': 'a' * 40,
                                        'mcp-nixos': release('utensils', 'mcp-nixos', 'v3.1.0')})
            write_pins(root, 'other', {'skills': 'c' * 40})
            # A profile without pins contributes nothing and must not fail.
            (root / 'profiles' / 'vanilla').mkdir()
            result = subprocess.run(['python3', str(SCRIPTS / 'read-pins.py')],
                                    cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            # A branch pin is at a revision; a release pin is at its release.
            self.assertEqual(json.loads(result.stdout), {
                'juspay/skills': {'at': 'aaaaaaa'},
                'juspay/mcp-nixos': {
                    'at': 'v3.1.0',
                    'notes': 'https://github.com/utensils/mcp-nixos/releases/tag/v3.1.0',
                },
                'other/skills': {'at': 'ccccccc'},
            })

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
                   PINS_BEFORE='{}', PINS_AFTER='{}',
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

    def test_report_names_pins_by_where_they_are(self):
        notes = 'https://github.com/utensils/mcp-nixos/releases/tag/'
        with tempfile.TemporaryDirectory() as directory:
            outputs, body = self.report(
                Path(directory),
                PINS_BEFORE=json.dumps({'juspay/skills': {'at': 'aaaaaaa'},
                                        'juspay/kolu': {'at': 'bbbbbbb'},
                                        'juspay/mcp-nixos': {'at': 'v3.0.2', 'notes': notes + 'v3.0.2'}}),
                PINS_AFTER=json.dumps({'juspay/skills': {'at': 'ccccccc'},
                                       'juspay/kolu': {'at': 'bbbbbbb'},
                                       'juspay/mcp-nixos': {'at': 'v3.1.0', 'notes': notes + 'v3.1.0'}}))
            self.assertIn('juspay/skills aaaaaaa → ccccccc', outputs['pr-title'])
            self.assertIn('juspay/mcp-nixos v3.0.2 → v3.1.0', outputs['pr-title'])
            self.assertNotIn('juspay/kolu', outputs['pr-title'])
            self.assertIn('- `juspay/skills` `aaaaaaa` → `ccccccc`\n', body)
            self.assertIn(f'- `juspay/mcp-nixos` `v3.0.2` → `v3.1.0` — release notes: {notes}v3.1.0', body)
            self.assertIn('- `juspay/kolu` unchanged (`bbbbbbb`)', body)


if __name__ == '__main__':
    unittest.main()
