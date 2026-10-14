/**
 * Stdout is a protocol channel, never a log: at AGENT_DISTRO_LOG=trace the
 * launch still prints only shell assignments, `--list --json` only JSON, model
 * discovery only a path and `update.ts --progress` only JSON lines, while the
 * debug lines all reach stderr.
 *
 * Usage: node check-log-stdout.ts SRC PLUGIN
 *
 * PLUGIN is a plugin directory (test/fixtures/my-skills), loaded through
 * AGENT_DISTRO_PLUGINS so the launch has plugins to log.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const [src, plugin] = process.argv.slice(2);
const temporary = () => mkdtempSync(join(tmpdir(), 'log-stdout-'));
const info = { default: 'vanilla', builtins: [{ name: 'vanilla', description: '', gateway: null }], nixpkgs: '/nix/store/x-nixpkgs', system: 'x86_64-linux' };

/** Run a runtime module at trace level, from a directory in no repository. */
function run(args: string[], env: Record<string, string> = {}) {
  const home = temporary();
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', cwd: temporary(), timeout: 30_000,
    env: { PATH: process.env.PATH ?? '', HOME: home, XDG_CACHE_HOME: join(home, '.cache'), AGENT_DISTRO_LOG: 'trace', ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  // Every stderr line is a message in the one format, or the rest of a multi-line one.
  assert.ok(result.stderr === '' || result.stderr.startsWith('agent-distro'), result.stderr);
  return result;
}

/** A script `node` runs as a command: a fake curl or nix. */
function command(name: string, body: string): string {
  const path = join(temporary(), name);
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

test('a launch prints shell assignments only', () => {
  const args = join(temporary(), 'args.json');
  writeFileSync(args, JSON.stringify({ harness: 'claude', bash: '/bin/sh', env: '/usr/bin/env', profile: [], info }));
  const { stdout, stderr } = run([join(src, 'plugin/launch-cli.mjs'), args], { AGENT_DISTRO_PLUGINS: plugin });
  for (const line of stdout.trimEnd().split('\n')) {
    assert.match(line, /^(unset [A-Za-z_]\w*|export [A-Za-z_]\w*|[A-Za-z_]\w*='(?:[^']|'"'"')*'(?:"\$\{PATH:\+:\$PATH\}")?)$/, stdout);
  }
  assert.match(stdout, /^launched='--plugin-dir /m);
  assert.match(stderr, /^agent-distro plugin: .*my-skills: from AGENT_DISTRO_PLUGINS/m);
  assert.match(stderr, /^agent-distro claude: harness arguments: --plugin-dir /m);
  assert.match(stderr, /^agent-distro gateway: no gateway$/m);
});

test('--list --json prints JSON only', () => {
  const infoFile = join(temporary(), 'info.json');
  writeFileSync(infoFile, JSON.stringify(info));
  const menu = { profiles: [{ name: 'vanilla', description: 'Vanilla', harnesses: [] }] };
  const { stdout, stderr } = run([join(src, 'profile/cli.ts'), 'list', infoFile, JSON.stringify(menu), '--json']);
  assert.equal(JSON.parse(stdout).profile.source, 'builtin');
  assert.equal(stdout.trimEnd().split('\n').length, 1);
  assert.equal(stderr, '');
});

test('model discovery prints a path only', () => {
  const directory = temporary();
  const base = join(directory, 'base.json');
  writeFileSync(base, JSON.stringify({ provider: { litellm: { options: { baseURL: 'https://gateway.invalid' }, models: [] } } }));
  const shape = join(directory, 'shape.json');
  writeFileSync(shape, JSON.stringify({ provider: ['provider', 'litellm'], url: ['options', 'baseURL'], label: 'OpenCode' }));
  const curl = command('curl', `process.stdout.write(JSON.stringify({ data: [{ id: 'served' }] }));\n`);
  const cache = join(directory, 'cache', 'models.json');
  const { stdout, stderr } = run([join(src, 'gateway/models.ts'), base, cache, curl, 'GATEWAY_KEY', shape], { GATEWAY_KEY: 'secret' });
  assert.equal(stdout, cache + '\n');
  assert.deepEqual(JSON.parse(readFileSync(cache, 'utf8')).provider.litellm.models, [{ id: 'served' }]);
  assert.match(stderr, /^agent-distro gateway: discovering OpenCode models at https:\/\/gateway\.invalid …$/m);
  assert.match(stderr, /^agent-distro gateway: gateway https:\/\/gateway\.invalid, key in \$GATEWAY_KEY$/m);
  assert.ok(!stderr.includes('secret'), stderr);
});

test('update --progress prints JSON lines only', () => {
  const state = temporary();
  const bundle = join(temporary(), 'bundle');
  mkdirSync(bundle);
  // Enough nix for one update: a trusted store, a resolvable flake, nothing to compile, a build.
  const nix = command('nix', `
const { symlinkSync } = require('node:fs');
const args = process.argv.slice(2);
const has = (word) => args.includes(word);
if (args[0] === 'store') process.stdout.write('{"trusted":true}');
else if (args[0] === 'flake') process.stdout.write('{"url":"path:/fixture"}');
else if (args[0] === 'build' && has('--out-link')) symlinkSync(${JSON.stringify(bundle)}, args[args.indexOf('--out-link') + 1]);
`);
  const config = join(temporary(), 'config.json');
  writeFileSync(config, JSON.stringify({
    profile: 'p', flake: 'path:/fixture', state, history: join(state, 'history.log'), nix,
    substituters: {}, caIndex: 'https://example.invalid/ca-index', periodSeconds: 21600, offsetSeconds: 7200,
  }));
  const { stdout, stderr } = run([join(src, 'update/update.ts'), config, '--progress']);
  const lines = stdout.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.at(-1), { result: 'updated', bundle });
  assert.match(stderr, /^agent-distro update: running .*nix flake metadata --refresh --json path:\/fixture$/m);
  assert.match(stderr, /^agent-distro update: p updated nothing -> /m);
});
