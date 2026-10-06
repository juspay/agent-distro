/**
 * The updater must never compile: whatever stops it reading what a build
 * would do is a skip, however large nix's answer is. A fake nix stands in.
 *
 * Usage: node check-would-compile.ts SRC
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { update, wouldCompile } = await import(join(process.argv[2], 'update/update.ts'));
const work = mkdtempSync(join(tmpdir(), 'would-compile-'));

type Fake = {
  /** Derivations the dry run lists. */
  drvs: number;
  /** Lines of paths to fetch the dry run also prints, to make it large. */
  fetched?: number;
  /** `json`: a full answer; `truncated`; `fail`; or a literal JSON answer. */
  show?: 'json' | 'truncated' | 'fail' | { raw: string };
};

/** A nix answering per `fake`; every call is logged, so a test can tell whether a real build ran. */
function fakeNix(name: string, { drvs, fetched = 0, show = 'json' }: Fake): string {
  const path = join(work, name);
  writeFileSync(path, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path + '.log')}, args.join(' ') + '\\n');
const store = (i, suffix) => '/nix/store/' + String(i).padStart(32, '0') + '-pkg-' + i + suffix;
const show = ${JSON.stringify(show)};
if (args[0] === 'store') console.log(JSON.stringify({ trusted: 1, url: 'daemon' }));
else if (args[0] === 'config') console.log('');
else if (args[0] === 'flake') console.log(JSON.stringify({ url: 'path:/fixture' }));
else if (args[0] === 'build' && args.includes('--dry-run')) {
  const lines = ['these ${drvs} derivations will be built:'];
  for (let i = 0; i < ${drvs}; i++) lines.push('  ' + store(i, '.drv'));
  lines.push('these ${fetched} paths will be fetched:');
  for (let i = 0; i < ${fetched}; i++) lines.push('  ' + store(i, ''));
  console.error(lines.join('\\n'));
} else if (args[0] === 'derivation') {
  if (show === 'fail') process.exit(1);
  if (typeof show === 'object') process.stdout.write(show.raw);
  else {
    const derivations = {};
    // Padding stands in for the inputs and env a real derivation carries.
    for (const [i, path] of args.slice(2).entries()) {
      derivations[path] = { name: 'pkg-' + i, env: i === 0 ? { allowSubstitutes: '' } : { pad: 'x'.repeat(3000) } };
    }
    const text = JSON.stringify({ derivations });
    process.stdout.write(show === 'truncated' ? text.slice(0, text.length / 2) : text);
  }
} else if (args[0] === 'build') {
  // The real build: an out-link to a bundle that records its versions.
  const bundle = ${JSON.stringify(join(work, name + '-bundle'))};
  fs.mkdirSync(bundle + '/share/agent-distro', { recursive: true });
  fs.writeFileSync(bundle + '/share/agent-distro/versions', 'pi\\tPi\\t1.0\\n');
  const link = args[args.indexOf('--out-link') + 1];
  fs.rmSync(link, { force: true });
  fs.symlinkSync(bundle, link);
}
`);
  chmodSync(path, 0o755);
  return path;
}

function run(nix: string) {
  const state = join(work, `${nix}-state`);
  const history = join(work, `${nix}-history.log`);
  const status = update({
    profile: 'p', flake: 'path:/fixture', state, history, nix,
    substituters: {}, periodSeconds: 21600, offsetSeconds: 7200,
  });
  const builds = readFileSync(nix + '.log', 'utf8').split('\n')
    .filter((line) => line.startsWith('build ') && !line.includes('--dry-run'));
  return { status, builds, history: readFileSync(history, 'utf8'), stamped: existsSync(join(state, 'last-success')) };
}

test('megabytes of derivation show still name what would compile', () => {
  const nix = fakeNix('large', { drvs: 1400 });
  // The unsubstitutable first derivation is not a miss.
  assert.deepEqual(wouldCompile(nix, 'path:/fixture#p', []), { names: 'pkg-1,pkg-2,pkg-3' });
});

test('a dry run over 1 MiB is read whole', () => {
  // About 1.3 MiB of paths to fetch, with the derivations to build last.
  const nix = fakeNix('long-dry-run', { drvs: 5, fetched: 16000 });
  assert.deepEqual(wouldCompile(nix, 'path:/fixture#p', []), { names: 'pkg-1,pkg-2,pkg-3' });
});

test('nothing to build is nothing to compile', () => {
  assert.deepEqual(wouldCompile(fakeNix('none', { drvs: 0 }), 'path:/fixture#p', []), { names: '' });
});

for (const show of ['truncated', 'fail'] as const) {
  test(`a ${show} derivation show is unknown, not nothing`, () => {
    assert.ok('unknown' in wouldCompile(fakeNix(show, { drvs: 5, show }), 'path:/fixture#p', []));
  });
}

// Valid JSON that does not describe every derivation the dry run named.
for (const raw of ['{}', '[]', '42', 'true', 'null', '{"derivations":{}}',
  JSON.stringify({ derivations: { [`/nix/store/${'0'.repeat(32)}-pkg-0.drv`]: { name: 'pkg-0' } } })]) {
  test(`derivation show answering ${raw.slice(0, 40)} is unknown`, () => {
    const nix = fakeNix(`partial-${raw.length}-${raw[0]}`, { drvs: 2, show: { raw } });
    assert.ok('unknown' in wouldCompile(nix, 'path:/fixture#p', []));
  });
}

test('an update that cannot tell skips without building', () => {
  const result = run(fakeNix('unknown', { drvs: 1400, show: { raw: '{}' } }));
  assert.equal(result.status, 0);
  assert.deepEqual(result.builds, []);
  assert.match(result.history, / p skipped: cannot tell what the bundle would build /);
  assert.ok(!result.stamped);
});

test('an update with nothing to compile builds', () => {
  const result = run(fakeNix('cached', { drvs: 0 }));
  assert.equal(result.status, 0);
  assert.equal(result.builds.length, 1);
  assert.match(result.history, / p updated: Pi 1\.0\n$/);
  assert.ok(result.stamped);
});
