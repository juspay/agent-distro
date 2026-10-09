/**
 * `check-profile` without a real nix: one line per package, every package
 * reported, and the exit status that CI reads. A fake nix on PATH answers the
 * evaluation and each package's dry run.
 *
 * Usage: node check-check-profile.ts SRC
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const [src] = process.argv.slice(2);
const work = mkdtempSync(join(tmpdir(), 'check-profile-'));
const store = (name: string, suffix = '') => `/nix/store/${'0'.repeat(32)}-${name}${suffix}`;

/**
 * `eval` prints the profile in fake.json (an evaluation sees no environment);
 * a dry run lists the derivation of a package named in its `miss` (to build)
 * or `unknown` (which `derivation show` then cannot describe); everything is
 * logged.
 */
const bin = join(work, 'bin');
mkdirSync(bin);
const log = join(work, 'log');
writeFileSync(join(bin, 'nix'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
const fake = JSON.parse(fs.readFileSync(${JSON.stringify(join(work, 'fake.json'))}, 'utf8'));
const miss = fake.miss;
const unknown = fake.unknown;
const drv = (name) => '/nix/store/' + '0'.repeat(32) + '-' + name + '.drv';
if (args[0] === 'eval') process.stdout.write(fake.profile);
else if (args[0] === 'build' && args.includes('--dry-run')) {
  const name = args[1].replace(/^\\/nix\\/store\\/0+-/, '').replace(/\\.drv\\^\\*$/, '');
  if (miss.includes(name) || unknown.includes(name)) console.error('these derivations will be built:\\n  ' + drv(name));
} else if (args[0] === 'derivation') {
  const name = args[2].match(/-(.+)\\.drv$/)[1];
  if (unknown.includes(name)) process.stdout.write('{}');
  else process.stdout.write(JSON.stringify({ derivations: { [args[2]]: { name, env: {} } } }));
}
`);
chmodSync(join(bin, 'nix'), 0o755);

const info = join(work, 'info.json');
writeFileSync(info, JSON.stringify({ default: 'vanilla', builtins: [], nixpkgs: '/nixpkgs', system: 'x86_64-linux' }));
const caches = join(work, 'caches.json');
writeFileSync(caches, JSON.stringify({ substituters: ['https://cache.example/oss'], trustedPublicKeys: ['oss:key'] }));
const file = join(work, 'agent-distro.nix');
writeFileSync(file, '{ }\n');

const profile = (...packages: string[]) => JSON.stringify({
  name: 'p', description: '', plugins: [], gateway: null,
  packages: packages.map((name) => ({ name, drvPath: store(name, '.drv'), out: store(name), bin: store(name, '/bin') })),
});

function check(argv: string[], fake: { profile?: string; miss?: string[]; unknown?: string[] } = {}) {
  writeFileSync(join(work, 'fake.json'), JSON.stringify({ profile: profile(), miss: [], unknown: [], ...fake }));
  const result = spawnSync(process.execPath, [join(src, 'profile/check-cli.ts'), info, caches, ...argv], {
    encoding: 'utf8', cwd: work,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: work },
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test('every package cached: one line each, exit 0', () => {
  const result = check([file], { profile: profile('hello-2.12', 'jq-1.7') });
  assert.equal(result.status, 0);
  assert.equal(result.out, 'hello-2.12: cached\njq-1.7: cached\n');
});

test('the answer is about agent-distro\'s caches, not the runner\'s', () => {
  check([file], { profile: profile('hello-2.12') });
  const dryRun = readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('--dry-run')).at(-1)!;
  assert.match(dryRun, /--option substituters https:\/\/cache\.example\/oss --option trusted-public-keys oss:key/);
});

test('a package that would build fails, naming it in the launcher\'s words, after every package is reported', () => {
  const result = check([file], { profile: profile('mcp-nixos-3.0.1', 'hello-2.12', 'other-1.0'), miss: ['mcp-nixos-3.0.1', 'other-1.0'] });
  assert.equal(result.status, 1);
  assert.equal(result.out, [
    `${file}: package mcp-nixos-3.0.1 is not in the binary cache (would build mcp-nixos-3.0.1)`,
    'hello-2.12: cached',
    `${file}: package other-1.0 is not in the binary cache (would build other-1.0)`,
  ].join('\n') + '\n');
});

test('a package that cannot be told fails', () => {
  const result = check([file], { profile: profile('hello-2.12', 'odd-1.0'), unknown: ['odd-1.0'] });
  assert.equal(result.status, 1);
  assert.match(result.out, /^hello-2\.12: cached\n.*: cannot tell whether package odd-1\.0 is in the binary cache \(nix derivation show did not describe /);
});

test('no packages is nothing to fail', () => {
  const result = check([file]);
  assert.equal(result.status, 0);
  assert.match(result.out, /: no packages\n$/);
});

test('a directory names the agent-distro.nix in it', () => {
  assert.equal(check([work], { profile: profile('hello-2.12') }).out, 'hello-2.12: cached\n');
});

test('a missing file is a usage error', () => {
  const result = check([join(work, 'missing.nix')]);
  assert.equal(result.status, 2);
  assert.match(result.err, /usage: check-profile/);
  assert.equal(result.out, '');
});

test('too many arguments is a usage error', () => {
  assert.equal(check([file, file]).status, 2);
});
