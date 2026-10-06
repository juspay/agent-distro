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

/**
 * A nix whose dry run lists `count` derivations and whose `derivation show`
 * answers per `show`: `json` (the full answer), `truncated`, or `fail`.
 * Every call is logged, so a test can tell whether a real build ran.
 */
function fakeNix(name: string, count: number, show: 'json' | 'truncated' | 'fail'): string {
  const path = join(work, name);
  writeFileSync(path, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path + '.log')}, args.join(' ') + '\\n');
const drv = (i) => '/nix/store/' + String(i).padStart(32, '0') + '-pkg-' + i + '.drv';
if (args[0] === 'store') console.log(JSON.stringify({ trusted: 1, url: 'daemon' }));
else if (args[0] === 'config') console.log('');
else if (args[0] === 'flake') console.log(JSON.stringify({ url: 'path:/fixture' }));
else if (args[0] === 'build' && args.includes('--dry-run')) {
  const lines = ['these ${count} derivations will be built:'];
  for (let i = 0; i < ${count}; i++) lines.push('  ' + drv(i));
  console.error(lines.join('\\n'));
} else if (args[0] === 'derivation') {
  if (${JSON.stringify(show)} === 'fail') process.exit(1);
  const derivations = {};
  // Padding stands in for the inputs and env a real derivation carries.
  for (const [i, path] of args.slice(2).entries()) {
    derivations[path] = { name: 'pkg-' + i, env: i === 0 ? { allowSubstitutes: '' } : { pad: 'x'.repeat(3000) } };
  }
  const text = JSON.stringify({ derivations });
  process.stdout.write(${JSON.stringify(show)} === 'truncated' ? text.slice(0, text.length / 2) : text);
} else process.exit(0);
`);
  chmodSync(path, 0o755);
  return path;
}

test('megabytes of derivation show still name what would compile', () => {
  const nix = fakeNix('large', 1400, 'json');
  // The unsubstitutable first derivation is not a miss.
  assert.deepEqual(wouldCompile(nix, 'path:/fixture#p', []), { names: 'pkg-1,pkg-2,pkg-3' });
});

test('nothing to build is nothing to compile', () => {
  assert.deepEqual(wouldCompile(fakeNix('none', 0, 'json'), 'path:/fixture#p', []), { names: '' });
});

for (const show of ['truncated', 'fail'] as const) {
  test(`a ${show} derivation show is unknown, not nothing`, () => {
    assert.ok('unknown' in wouldCompile(fakeNix(show, 5, show), 'path:/fixture#p', []));
  });
}

test('an update that cannot tell skips without building', () => {
  const nix = fakeNix('update', 1400, 'truncated');
  const state = join(work, 'state');
  const history = join(work, 'history.log');
  const status = update({
    profile: 'p', flake: 'path:/fixture', state, history, nix,
    substituters: {}, periodSeconds: 21600, offsetSeconds: 7200,
  });
  assert.equal(status, 0);
  const builds = readFileSync(nix + '.log', 'utf8').split('\n').filter((line) => line.startsWith('build ') && !line.includes('--dry-run'));
  assert.deepEqual(builds, []);
  assert.match(readFileSync(history, 'utf8'), / p skipped: cannot tell what the bundle would build /);
  assert.ok(!existsSync(join(state, 'last-success')));
});
