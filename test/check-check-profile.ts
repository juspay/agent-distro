/**
 * `check-profile` without a real nix: one line per package, every package
 * reported, and the exit status that CI reads. A fake nix on PATH answers the
 * packages evaluation and each package's dry run. A profile is a `plugin.json`;
 * an `agent-distro.nix` is the migration error.
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
const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const NAMESPACE = 'asia.nixos.agent-distro';

/**
 * `eval` answers the profile's packages from its `attributes` (each its own
 * derivation); a dry run lists the derivation of a package named in its `miss`
 * (to build) or `unknown` (which `derivation show` then cannot describe);
 * everything is logged.
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
if (args[0] === 'eval') {
  // A profile's packages: attribute paths, each its own derivation.
  const expr = args[args.indexOf('--expr') + 1];
  const literal = expr.slice(expr.indexOf('(builtins.fromJSON ') + 19, -1).replaceAll('\\$', '$');
  const given = JSON.parse(JSON.parse(literal));
  if (!Array.isArray(given.attributes)) { console.error('unexpected: ' + expr); process.exit(1); }
  process.stdout.write(JSON.stringify(given.attributes.map((name) => ({
    name, drvPath: drv(name), out: '/nix/store/' + '0'.repeat(32) + '-' + name,
    bin: '/nix/store/' + '0'.repeat(32) + '-' + name + '/bin',
  }))));
} else if (args[0] === 'build' && args.includes('--dry-run')) {
  const name = args[1].replace(/^\\/nix\\/store\\/0+-/, '').replace(/\\.drv\\^\\*$/, '');
  if (miss.includes(name) || unknown.includes(name)) console.error('these derivations will be built:\\n  ' + drv(name));
} else if (args[0] === 'derivation') {
  const name = args[2].match(/-(.+)\\.drv$/)[1];
  if (unknown.includes(name)) process.stdout.write('{}');
  else process.stdout.write(JSON.stringify({ derivations: { [args[2]]: { name, env: {} } } }));
} else { console.error('unexpected: ' + args.join(' ')); process.exit(1); }
`);
chmodSync(join(bin, 'nix'), 0o755);

const info = join(work, 'info.json');
writeFileSync(info, JSON.stringify({ nixpkgs: '/nixpkgs', system: 'x86_64-linux' }));
const caches = join(work, 'caches.json');
writeFileSync(caches, JSON.stringify({ substituters: ['https://cache.example/oss'], trustedPublicKeys: ['oss:key'] }));

/** A profile directory: a `plugin.json` naming the packages the extension gives. */
const profile = (name: string, ...packages: string[]) => {
  const directory = join(work, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify({
    $schema: SCHEMA, name: 'p', extensions: { [NAMESPACE]: { packages } },
  }));
  return directory;
};

function check(argv: string[], fake: { miss?: string[]; unknown?: string[] } = {}) {
  writeFileSync(join(work, 'fake.json'), JSON.stringify({ miss: [], unknown: [], ...fake }));
  const result = spawnSync(process.execPath, [join(src, 'profile/check-cli.ts'), info, caches, ...argv], {
    encoding: 'utf8', cwd: work,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: work },
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

test('every package cached: one line each, exit 0', () => {
  const result = check([profile('cached', 'hello-2.12', 'jq-1.7')]);
  assert.equal(result.status, 0, result.err);
  assert.equal(result.out, 'hello-2.12: cached\njq-1.7: cached\n');
});

test('the answer is about agent-distro\'s caches, not the runner\'s', () => {
  check([profile('caches', 'hello-2.12')]);
  const dryRun = readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('--dry-run')).at(-1)!;
  assert.match(dryRun, /--option substituters https:\/\/cache\.example\/oss --option trusted-public-keys oss:key/);
});

test('a package that would build fails, naming it in the launcher\'s words, after every package is reported', () => {
  const directory = profile('missed', 'mcp-nixos-3.0.1', 'hello-2.12', 'other-1.0');
  const result = check([directory], { miss: ['mcp-nixos-3.0.1', 'other-1.0'] });
  assert.equal(result.status, 1);
  assert.equal(result.out, [
    `${directory}: package mcp-nixos-3.0.1 is not in the binary cache (would build mcp-nixos-3.0.1)`,
    'hello-2.12: cached',
    `${directory}: package other-1.0 is not in the binary cache (would build other-1.0)`,
  ].join('\n') + '\n');
});

test('a package that cannot be told fails', () => {
  const directory = profile('odd', 'hello-2.12', 'odd-1.0');
  const result = check([directory], { unknown: ['odd-1.0'] });
  assert.equal(result.status, 1);
  assert.match(result.out, /^hello-2\.12: cached\n.*: cannot tell whether package odd-1\.0 is in the binary cache \(nix derivation show did not describe /);
});

test('no packages is nothing to fail', () => {
  const result = check([profile('bare')]);
  assert.equal(result.status, 0);
  assert.match(result.out, /: no packages\n$/);
});

test('a directory names the plugin.json in it, and the file itself too', () => {
  const directory = profile('named', 'hello-2.12');
  assert.equal(check([directory]).out, 'hello-2.12: cached\n');
  assert.equal(check([join(directory, 'plugin.json')]).out, 'hello-2.12: cached\n');
});

test('an agent-distro.nix is the migration error, naming the file', () => {
  const directory = join(work, 'legacy');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'agent-distro.nix'), '{ }\n');
  const result = check([directory]);
  assert.equal(result.status, 1);
  assert.match(result.err, /agent-distro\.nix is no longer read/);
  assert.match(result.err, /agent-distro\.nix/);
  assert.match(result.err, /extensions\."asia\.nixos\.agent-distro"/);
  assert.match(result.err, /agent-distro\.nixos\.asia\/#profiles/);
  assert.match(result.err, /agent-distro\.schema\.json/);
});

test('a directory with neither file names what is missing', () => {
  const directory = join(work, 'neither');
  mkdirSync(directory, { recursive: true });
  const result = check([directory]);
  assert.equal(result.status, 2);
  assert.match(result.err, /no plugin\.json at /);
  assert.match(result.err, /usage: check-profile/);
});

test('a file that is not a plugin.json is refused', () => {
  const missing = join(work, 'missing.nix');
  writeFileSync(missing, '{ }\n');
  const result = check([missing]);
  assert.equal(result.status, 1);
  assert.match(result.err, /is not a plugin\.json/);
});

test('a missing path is a usage error', () => {
  const result = check([join(work, 'nothing-here')]);
  assert.equal(result.status, 2);
  assert.match(result.err, /usage: check-profile/);
  assert.equal(result.out, '');
});

test('too many arguments is a usage error', () => {
  assert.equal(check([profile('many'), profile('more')]).status, 2);
});
