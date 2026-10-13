"""Exercise the content-addressed index build with a stub nix: no store here."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
IA = '/nix/store/' + 'a' * 32 + '-agent-distro-vanilla'
CA = '/nix/store/' + 'b' * 32 + '-agent-distro-vanilla'
OTHER_IA = '/nix/store/' + 'c' * 32 + '-agent-distro-team'
OTHER_CA = '/nix/store/' + 'd' * 32 + '-agent-distro-team'

# A content-addressed path announces itself; the index script checks this
# before it publishes one for the untrusted updater to fetch.
CONTENT_ADDRESSED = 'fixed:r:sha256:' + 'abc'

STUB = '''#!/usr/bin/env python3
"""A nix answering the calls ca-index.py makes, from the canned JSON a test wrote."""
import json, os, sys
key = ' '.join(sys.argv[1:])
with open(os.environ['CA_CALLS'], 'a') as calls:
    calls.write(key + '\\n')
answers = json.load(open(os.environ['CA_ANSWERS']))
if key not in answers:
    sys.exit(f'stub nix: unexpected {key}')
print(answers[key], end='')
'''


def answers(root: Path, *bundles: tuple, rewrite: str = None, info: str = None, extra: dict = None) -> dict:
    """The canned answers for `(installable, ia, ca)` bundles, and the PATH that reaches them.

    `rewrite` and `info` replace the answer every bundle's rewrite and
    `path-info` call gets, and `extra` replaces one answer by its arguments,
    for the cases where nix does not do its part.
    """
    canned = {}
    for installable, ia, ca in (bundles or (('.#vanilla', IA, CA),)):
        canned[f'build --no-link --print-out-paths {installable}'] = ia + '\n'
        canned[f'store make-content-addressed --json {ia}'] = (
            rewrite if rewrite is not None else json.dumps({'rewrites': {ia: ca}}))
        canned[f'path-info --json-format 1 --json {ca}'] = (
            info if info is not None else json.dumps({ca: {'ca': CONTENT_ADDRESSED}}))
    canned.update(extra or {})
    tools = root / 'bin'
    tools.mkdir(exist_ok=True)
    nix = tools / 'nix'
    nix.write_text(STUB)
    nix.chmod(0o755)
    (root / 'answers.json').write_text(json.dumps(canned))
    return dict(os.environ, PATH=f'{tools}:{os.environ["PATH"]}',
                CA_CALLS=str(root / 'calls'), CA_ANSWERS=str(root / 'answers.json'))


def index(root: Path, env: dict, *args: str, system: str = 'x86_64-linux') -> subprocess.CompletedProcess:
    """Run the script for one revision, system and index tree."""
    return subprocess.run(
        [sys.executable, str(SCRIPTS / 'ca-index.py'), '--rev', 'f' * 40, '--system', system,
         '--directory', str(root / 'ca-index'), *args],
        cwd=root, env=env, capture_output=True, text=True)


class CaIndexTests(unittest.TestCase):
    def test_writes_the_entry_and_the_pair_in_the_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = index(root, answers(root), '.#vanilla')
            self.assertEqual(result.returncode, 0, result.stderr)
            entry = root / 'ca-index' / ('f' * 40) / 'x86_64-linux' / 'vanilla.json'
            self.assertEqual(json.loads(entry.read_text()), {'ia': IA, 'ca': CA})
            # Without --latest there is nothing that names a newest bundle.
            self.assertFalse((root / 'ca-index' / 'latest').exists())
            # The job's log carries what it published, for the pull request record.
            self.assertIn(f'{IA} -> {CA}', result.stdout)
            self.assertEqual((root / 'calls').read_text().splitlines(), [
                'build --no-link --print-out-paths .#vanilla',
                f'store make-content-addressed --json {IA}',
                f'path-info --json-format 1 --json {CA}'])

    def test_latest_names_the_newest_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = index(root, answers(root), '--latest', '.#vanilla')
            self.assertEqual(result.returncode, 0, result.stderr)
            latest = root / 'ca-index' / 'latest' / 'x86_64-linux' / 'vanilla.json'
            # The revision is with the pair, so a consumer can tell whether
            # what it already has is what this names.
            self.assertEqual(json.loads(latest.read_text()), {'rev': 'f' * 40, 'ia': IA, 'ca': CA})
            # The pair is in the log beside the revision it names.
            self.assertIn(f'latest/x86_64-linux/vanilla.json: {"f" * 40} -> {CA}', result.stdout)

    def test_a_darwin_entry_names_the_signed_bundle_and_nothing_rewritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = index(root, answers(root), '--latest', '.#vanilla', system='aarch64-darwin')
            self.assertEqual(result.returncode, 0, result.stderr)
            tree = root / 'ca-index'
            # A rewritten Mach-O does not run on arm64 macOS, so there is no ca:
            # the entry is the signed bundle, and nothing was rewritten for it.
            self.assertEqual(json.loads((tree / ('f' * 40) / 'aarch64-darwin' / 'vanilla.json').read_text()), {'ia': IA})
            self.assertEqual(json.loads((tree / 'latest' / 'aarch64-darwin' / 'vanilla.json').read_text()),
                             {'rev': 'f' * 40, 'ia': IA})
            self.assertEqual((root / 'calls').read_text().splitlines(), ['build --no-link --print-out-paths .#vanilla'])
            self.assertIn('signed: a rewritten Mach-O is killed on arm64 macOS', result.stdout)

    def test_each_installable_gets_its_own_pair(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = answers(root, ('.#vanilla', IA, CA), ('.#team', OTHER_IA, OTHER_CA))
            result = index(root, env, '.#vanilla', '.#team')
            self.assertEqual(result.returncode, 0, result.stderr)
            tree = root / 'ca-index' / ('f' * 40) / 'x86_64-linux'
            self.assertEqual(json.loads((tree / 'vanilla.json').read_text()), {'ia': IA, 'ca': CA})
            self.assertEqual(json.loads((tree / 'team.json').read_text()), {'ia': OTHER_IA, 'ca': OTHER_CA})

    def test_refuses_a_bundle_nix_did_not_rewrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = index(root, answers(root, rewrite=json.dumps({'rewrites': {}})), '.#vanilla')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('rewrote no path', result.stderr)
            self.assertFalse((root / 'ca-index').exists())

    def test_refuses_a_path_the_store_does_not_call_content_addressed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # A path without that mark is the signature-checked one the
            # untrusted updater cannot fetch, so publishing it would be a lie.
            env = answers(root, info=json.dumps({CA: {'ca': None}}))
            result = index(root, env, '.#vanilla')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('is not content-addressed', result.stderr)
            self.assertFalse((root / 'ca-index').exists())

    def test_refuses_a_build_that_printed_several_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = answers(root, extra={
                'build --no-link --print-out-paths .#vanilla': f'{IA}\n{OTHER_IA}\n'})
            result = index(root, env, '.#vanilla')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('not one store path', result.stderr)

    def test_refuses_a_profile_name_that_is_not_an_attribute(self):
        for installable in ['.#../evil', '.#', '.#a/b']:
            with self.subTest(installable=installable), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                result = index(root, answers(root), installable)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('is not a profile name', result.stderr)
                self.assertFalse((root / 'ca-index').exists())

    def test_refuses_a_revision_that_cannot_name_a_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = subprocess.run(
                [sys.executable, str(SCRIPTS / 'ca-index.py'), '--rev', '../main', '--system', 'x86_64-linux',
                 '--directory', str(root / 'ca-index'), '.#vanilla'],
                cwd=root, env=answers(root), capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('cannot name a directory', result.stderr)


if __name__ == '__main__':
    unittest.main()
