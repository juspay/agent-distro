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
                           '  .#harnesses.x86_64-linux.opencode.version) printf 1.18.33 ;;\n'
                           '  .#harnesses.x86_64-linux.opencode2.version) printf 2.0.20 ;;\n'
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
            expected = ('codex-version=0.153.0\nclaude-version=2.1.273\nopencode-version=1.18.33\nopencode2-version=2.0.20\n'
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
        cases = [(*case, '') for case in cases] + [
            ('v1.18.33', 'v2.0.9', 'v2.0.9', ''),
            ('v1.18.33', 'v2.0.9', 'v1.18.33', 'v1.'),
            ('v1.18.33', 'v10.0.0', 'v1.18.33', 'v1.'),
            ('v1.18.33', 'v1.18.34', 'v1.18.34', 'v1.'),
            ('v1.18.33', 'v1.18.32', 'v1.18.33', 'v1.'),
        ]
        for (input_name, repo), (before, latest, after, prefix) in product(
                [('oh-my-pi', 'can1357/oh-my-pi'), ('opencode', 'anomalyco/opencode')], cases):
            with self.subTest(input=input_name, before=before, latest=latest, prefix=prefix), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                flake = root / 'flake.nix'
                original = f'{input_name}.url = "github:{repo}/{before}";\n'
                flake.write_text(original)
                gh = root / 'gh'
                gh.write_text('#!/bin/sh\nprintf "%s\\n" "$TEST_LATEST"\n')
                gh.chmod(0o755)
                output = root / 'outputs'
                env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}',
                           TEST_LATEST=latest, GITHUB_OUTPUT=str(output))
                args = ['bash', str(SCRIPTS / 'advance-release-pin.sh'), input_name, repo]
                if prefix:
                    args.append(prefix)
                result = subprocess.run(args,
                                        cwd=root, env=env, capture_output=True, text=True)
                if after is None:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(flake.read_text(), original)
                    self.assertFalse(output.exists())
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(flake.read_text(), original.replace(before, after))
                    prefix_output = f'tag-prefix={prefix}\n' if prefix else ''
                    self.assertEqual(output.read_text(),
                                     f'before={before}\nafter={after}\nlatest={latest}\n' + prefix_output)

    def update_opencode2(self, root, before='2.0.9', latest='2.0.20',
                         metadata='ok', fallback='ok', prefetch='ok'):
        source = root / 'pkgs/opencode-v2/sources.json'
        source.parent.mkdir(parents=True)
        original = json.dumps({'version': before, 'hashes': {'old': 'preserve-me'}}) + '\n'
        source.write_text(original)
        source.chmod(0o644)
        inode = source.stat().st_ino
        curl = root / 'curl'
        curl.write_text('#!' + os.sys.executable + '\n' + r'''
import json, os, sys
from pathlib import Path
url = sys.argv[-1]
with Path('curl-calls').open('a') as output:
    output.write(url + '\n')
if url == 'https://opencode.ai/update/api/latest/cli/npm':
    mode, field = os.environ['METADATA'], 'version'
else:
    assert url == 'https://registry.npmjs.org/@opencode/cli-linux-x64/dist-tags'
    mode, field = os.environ['FALLBACK'], 'latest'
if mode == 'fail':
    sys.exit(22)
print('invalid json' if mode == 'malformed' else json.dumps({field: os.environ['LATEST']}))
''')
        curl.chmod(0o755)
        nix = root / 'nix'
        nix.write_text('#!' + os.sys.executable + '\n' + r'''
import json, os, sys
from pathlib import Path
assert sys.argv[1:4] == ['store', 'prefetch-file', '--json']
assert Path('pkgs/opencode-v2/sources.json').read_text() == os.environ['ORIGINAL']
url = sys.argv[-1]
with Path('nix-calls').open('a') as output:
    output.write(url + '\n')
if 'darwin-arm64' in url and os.environ['PREFETCH'] == 'fail':
    sys.exit(1)
print(json.dumps({'hash': 'bad' if os.environ['PREFETCH'] == 'bad-hash' else 'sha256-' + 'A' * 43 + '='}))
''')
        nix.chmod(0o755)
        output = root / 'outputs'
        output.write_text('existing=value\n')
        env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}', LATEST=latest,
                   METADATA=metadata, FALLBACK=fallback, PREFETCH=prefetch,
                   ORIGINAL=original, GITHUB_OUTPUT=str(output))
        result = subprocess.run(['bash', str(SCRIPTS / 'advance-opencode-v2.sh')],
                                cwd=root, env=env, capture_output=True, text=True)
        return result, source, original, inode, output

    def test_opencode2_npm_pin_moves_forward_atomically(self):
        for before, latest, metadata in [('2.0.9', '2.0.20', 'ok'),
                                         ('2.0.9', '2.0.10', 'fail'),
                                         ('2.0.9', '2.0.10', 'malformed')]:
            with self.subTest(metadata=metadata), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                result, source, _, inode, output = self.update_opencode2(root, before, latest, metadata)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotEqual(source.stat().st_ino, inode)
                self.assertEqual(source.stat().st_mode & 0o777, 0o644)
                self.assertEqual(json.loads(source.read_text()), {'version': latest, 'hashes': {
                    system: 'sha256-' + 'A' * 43 + '='
                    for system in ['x86_64-linux', 'aarch64-linux', 'aarch64-darwin']}})
                self.assertEqual((root / 'nix-calls').read_text().splitlines(), [
                    f'https://registry.npmjs.org/@opencode/cli-{target}/-/cli-{target}-{latest}.tgz'
                    for target in ['linux-x64', 'linux-arm64', 'darwin-arm64']])
                self.assertEqual(len((root / 'curl-calls').read_text().splitlines()), 1 if metadata == 'ok' else 2)
                self.assertEqual(output.read_text(), f'existing=value\nbefore={before}\nafter={latest}\nlatest={latest}\n')
                self.assertEqual(sorted(p.name for p in source.parent.iterdir()), ['sources.json'])

    def test_opencode2_npm_pin_holds_equal_or_older_versions(self):
        for latest in ['2.0.20', '2.0.9']:
            with self.subTest(latest=latest), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                result, source, original, inode, output = self.update_opencode2(root, before='2.0.20', latest=latest)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(source.read_text(), original)
                self.assertEqual(source.stat().st_ino, inode)
                self.assertFalse((root / 'nix-calls').exists())
                self.assertEqual(output.read_text(), f'existing=value\nbefore=2.0.20\nafter=2.0.20\nlatest={latest}\n')

    def test_opencode2_npm_failures_preserve_the_pin(self):
        for overrides in [{'metadata': 'fail', 'fallback': 'fail'},
                          {'latest': '2.0.21-beta'}, {'latest': ''}, {'before': 'broken'},
                          {'prefetch': 'fail'}, {'prefetch': 'bad-hash'}]:
            with self.subTest(overrides=overrides), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                result, source, original, inode, output = self.update_opencode2(root, **overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(source.read_text(), original)
                self.assertEqual(source.stat().st_ino, inode)
                self.assertEqual(output.read_text(), 'existing=value\n')
                self.assertEqual(sorted(p.name for p in source.parent.iterdir()), ['sources.json'])

    def report(self, root, **overrides):
        (root / 'flake-update.log').write_text('skills revision changed\n')
        env = dict(os.environ, OMP_BEFORE='v18.2.4', OMP_AFTER='v18.2.4', OMP_LATEST='v18.2.3',
                   CODEX_BEFORE='0.153.0', CODEX_AFTER='0.153.0',
                   CLAUDE_BEFORE='2.1.273', CLAUDE_AFTER='2.1.273',
                   OPENCODE_BEFORE='1.18.33', OPENCODE_AFTER='1.18.33', OPENCODE_LATEST='v1.18.33', OPENCODE_TAG_PREFIX='v1.',
                   OPENCODE2_BEFORE='2.0.20', OPENCODE2_AFTER='2.0.20', OPENCODE2_LATEST='2.0.20',
                   PINS_BEFORE='{}', PINS_AFTER='{}',
                   GITHUB_SERVER_URL='https://github.com', GITHUB_REPOSITORY='juspay/agent-distro',
                   GITHUB_RUN_ID='123', RUNNER_TEMP=str(root), GITHUB_OUTPUT=str(root / 'outputs'))
        env.update(overrides)
        subprocess.run(['python3', str(SCRIPTS / 'describe-flake-update.py')], env=env, check=True)
        outputs = dict(line.split('=', 1) for line in (root / 'outputs').read_text().splitlines())
        return outputs, Path(outputs['pr-body-path']).read_text()

    def test_report_uses_resolved_versions_and_preserves_lock_log(self):
        for omp_changed, codex_changed, claude_changed, opencode_changed, opencode2_changed in product([False, True], repeat=5):
            with self.subTest(omp=omp_changed, codex=codex_changed, claude=claude_changed, opencode=opencode_changed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                outputs, body = self.report(
                    root,
                    OMP_AFTER='v18.2.5' if omp_changed else 'v18.2.4',
                    OMP_LATEST='v18.2.5' if omp_changed else 'v18.2.3',
                    CODEX_AFTER='0.154.0' if codex_changed else '0.153.0',
                    CLAUDE_AFTER='2.1.274' if claude_changed else '2.1.273',
                    OPENCODE_AFTER='1.18.34+abcdef0' if opencode_changed else '1.18.33',
                    OPENCODE2_AFTER='2.0.21' if opencode2_changed else '2.0.20',
                    OPENCODE2_LATEST='2.0.21' if opencode2_changed else '2.0.20')
                self.assertIn('skills revision changed', body)
                self.assertIn('https://github.com/juspay/agent-distro/actions/runs/123', body)
                self.assertEqual('oh-my-pi v18.2.4 → v18.2.5' in outputs['pr-title'], omp_changed)
                self.assertEqual('Codex 0.153.0 → 0.154.0' in outputs['pr-title'], codex_changed)
                self.assertEqual('Claude Code 2.1.273 → 2.1.274' in outputs['pr-title'], claude_changed)
                self.assertEqual('OpenCode 1.18.33 → 1.18.34+abcdef0' in outputs['pr-title'], opencode_changed)
                self.assertEqual('OpenCode v2 2.0.20 → 2.0.21' in outputs['pr-title'], opencode2_changed)
                if opencode2_changed:
                    self.assertIn('/releases/tag/v2.0.21', body)
                else:
                    self.assertIn('OpenCode v2 unchanged (`2.0.20`)', body)
                if opencode_changed:
                    self.assertIn('https://github.com/anomalyco/opencode/releases/tag/v1.18.34', body)
                else:
                    self.assertIn('OpenCode unchanged (`1.18.33`)', body)
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

    def test_report_explains_opencode_prefix_hold(self):
        with tempfile.TemporaryDirectory() as directory:
            outputs, body = self.report(
                Path(directory), OPENCODE_BEFORE='1.18.33+abcdef0',
                OPENCODE_AFTER='1.18.33+abcdef0', OPENCODE_LATEST='v2.0.9')
            self.assertIn('latest release is `v2.0.9`; the pin is restricted to tag prefix `v1.`.', body)
            opencode_note = body.split('**OpenCode', 1)[1].split('**Profile pins**', 1)[0]
            self.assertNotIn('the pin only moves forward', opencode_note)
            self.assertNotIn('OpenCode', outputs['pr-title'])

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
