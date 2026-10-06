/**
 * AGENT_DISTRO_PLUGINS without a VM or a harness: cache keys, re-translation,
 * name-based precedence, and the launches it must fail.
 *
 * Usage: node check-launch-plugins.ts SRC STORE_PLUGIN STORE_SUBDIRECTORY_PLUGIN NIX_HASH
 *
 * STORE_PLUGIN is a plugin that is a store path of its own, and
 * STORE_SUBDIRECTORY_PLUGIN one inside a larger store path, as kolu ships it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const [src, storePlugin, storeSubdirectoryPlugin, nixHash] = process.argv.slice(2);
const launch = await import(join(src, 'plugin/launch.ts'));
const { adapter: claude } = await import(join(src, 'harness/claude.ts'));
const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

const temporary = () => mkdtempSync(join(tmpdir(), 'launch-plugins-'));

/** A plugin directory with one skill. */
function plugin(name: string, skill = 'hello', body = 'Hello'): string {
  const root = join(temporary(), name);
  mkdirSync(join(root, 'skills', skill), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ $schema: SCHEMA, name }));
  writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${body}\n---\n`);
  return root;
}

/** A profile entry as a launcher's ARGS_JSON lists it. */
function profileEntry(root: string, dir: string) {
  const description = join(temporary(), 'description.json');
  writeFileSync(description, JSON.stringify({
    root, version: '1.0.0', manifest: { $schema: SCHEMA, name: JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).name },
    skills: {}, mcpServers: {}, reports: [],
  }));
  return { description, dir };
}

const claudeArgs = (profile: unknown[] = []) => ({ harness: 'claude', bash: '/bin/sh', env: '/usr/bin/env', profile });

function resolve(value: string, cache: string, profile: unknown[] = [], reports: string[] = []) {
  return launch.resolve('claude', claude, claudeArgs(profile), value, cache, (message: string) => reports.push(message));
}

/** The launch CLI, as a launcher runs it. */
function run(value: string, env: Record<string, string> = {}) {
  const args = join(temporary(), 'args.json');
  writeFileSync(args, JSON.stringify(claudeArgs()));
  return spawnSync(process.execPath, [join(src, 'plugin/launch.ts'), args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, XDG_CACHE_HOME: temporary(), AGENT_DISTRO_PLUGINS: value, ...env },
  });
}

test('a store path is its own key, without hashing', () => {
  assert.equal(launch.cacheKey(storePlugin), 'store-' + storePlugin.slice('/nix/store/'.length));
  assert.match(launch.cacheKey(storeSubdirectoryPlugin), /^store-[a-z0-9]{32}-[^/]+%2F[^/]+$/);
  // An unreadable directory under /nix/store would fail any hash; the key never reads it.
  assert.equal(launch.cacheKey('/nix/store/00000000000000000000000000000000-absent/plugin'),
    'store-00000000000000000000000000000000-absent%2Fplugin');
  const cache = temporary();
  const [translated] = resolve(storeSubdirectoryPlugin, cache).plugins;
  assert.equal(translated.key, launch.cacheKey(storeSubdirectoryPlugin));
  assert.ok(translated.translation.startsWith(join(cache, 'plugins', translated.key, 'claude') + '/'));
});

test('the content hash is the NAR hash nix-hash computes', () => {
  const root = plugin('nar');
  writeFileSync(join(root, 'tool'), '#!/bin/sh\n');
  chmodSync(join(root, 'tool'), 0o755);
  mkdirSync(join(root, 'empty'));
  const expected = spawnSync(nixHash, ['--type', 'sha256', '--base16', root], { encoding: 'utf8' });
  assert.equal(expected.status, 0, expected.stderr);
  assert.equal(launch.narHash(root), expected.stdout.trim());
});

test('a checkout is keyed by content and path, and translated again after an edit', () => {
  const cache = temporary();
  const root = plugin('checkout', 'hello', 'Before');
  const first = resolve(root, cache).plugins[0];
  assert.match(first.key, /^sha256-[0-9a-f]{64}$/);
  const skill = join(first.translation, 'skills/hello/SKILL.md');
  assert.match(readFileSync(skill, 'utf8'), /Before/);
  // Unchanged: the same translation, not a new one.
  assert.equal(resolve(root, cache).plugins[0].translation, first.translation);
  writeFileSync(join(root, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: After\n---\n');
  const second = resolve(root, cache).plugins[0];
  assert.notEqual(second.key, first.key);
  assert.match(readFileSync(join(second.translation, 'skills/hello/SKILL.md'), 'utf8'), /After/);
  assert.match(readFileSync(skill, 'utf8'), /Before/, 'a translation in use is never rewritten');
  // The same contents elsewhere are another key: translations embed the root.
  const copy = join(temporary(), 'checkout');
  cpSync(root, copy, { recursive: true });
  assert.notEqual(resolve(copy, cache).plugins[0].key, second.key);
});

test('a translation is replaced only by name, and the variable wins', () => {
  const cache = temporary();
  const profile = [profileEntry(plugin('kolu'), '/profile/kolu'), profileEntry(plugin('skills'), '/profile/skills')];
  const early = plugin('kolu', 'early');
  const late = plugin('kolu', 'late');
  const extra = plugin('extra');
  const result = resolve([early, extra, late].join(':'), cache, profile);
  assert.deepEqual(result.kept.map((p: any) => p.entry.dir), ['/profile/skills']);
  assert.deepEqual(result.replaced.map((p: any) => p.name), ['kolu']);
  // The last `kolu` wins, in its own position.
  assert.deepEqual(result.plugins.map((p: any) => [p.name, p.description.root]), [['extra', extra], ['kolu', late]]);
  const words = claude.launch({ ...result, rest: [] });
  assert.equal(words, ['--plugin-dir /profile/skills', ...result.plugins.map((p: any) => `--plugin-dir ${p.translation}`)].join(' '));
  // A version never decides: a lower version on the variable still replaces.
  const versioned = plugin('skills');
  writeFileSync(join(versioned, 'plugin.json'), JSON.stringify({ $schema: SCHEMA, name: 'skills', version: '0.0.1' }));
  assert.deepEqual(resolve(versioned, cache, profile).replaced.map((p: any) => p.name), ['skills']);
});

test('empty components are ignored', () => {
  assert.deepEqual(launch.entries(''), []);
  assert.deepEqual(launch.entries('::a::b:'), ['a', 'b']);
});

test('reports reach stderr on every launch, cached or not', () => {
  const cache = temporary();
  const root = plugin('reported');
  writeFileSync(join(root, 'mcp.json'), '{');
  for (let i = 0; i < 2; i++) {
    const reports: string[] = [];
    resolve(root, cache, [], reports);
    assert.equal(reports.length, 1, JSON.stringify(reports));
    assert.match(reports[0], /mcp\.json: MCP disabled, it is not valid JSON/);
  }
});

test('an invalid manifest fails the launch naming the field', () => {
  const root = plugin('invalid');
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ $schema: SCHEMA, name: 'Invalid Name' }));
  const result = run(root);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /AGENT_DISTRO_PLUGINS: .*invalid: invalid Agent Plugin: `name` "Invalid Name" must be/);
});

test('an entry that is not a directory fails the launch naming it', () => {
  const missing = join(temporary(), 'missing');
  const result = run(`${plugin('fine')}:${missing}`);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, `agent-distro: AGENT_DISTRO_PLUGINS: ${missing} is not a directory\n`);
  const file = join(temporary(), 'file');
  writeFileSync(file, '');
  assert.match(run(file).stderr, /is not a directory/);
});

test('a cache that cannot be written fails the launch', () => {
  const blocked = join(temporary(), 'blocked');
  writeFileSync(blocked, '');
  const result = run(plugin('uncached'), { XDG_CACHE_HOME: blocked });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^agent-distro: .*ENOTDIR/);
  const args = join(temporary(), 'args.json');
  writeFileSync(args, JSON.stringify(claudeArgs()));
  const homeless = spawnSync(process.execPath, [join(src, 'plugin/launch.ts'), args], {
    encoding: 'utf8', env: { AGENT_DISTRO_PLUGINS: plugin('homeless') },
  });
  assert.equal(homeless.status, 1, homeless.stderr);
  assert.match(homeless.stderr, /XDG_CACHE_HOME and HOME are unset/);
});

test('a translation is published whole, once', () => {
  const cache = temporary();
  const root = plugin('atomic');
  const { key } = resolve(root, cache).plugins[0];
  resolve(root, cache);
  const entries = readdirSync(join(cache, 'plugins', key, 'claude'));
  // One directory and the link naming it; nothing half-written.
  assert.equal(entries.length, 2, JSON.stringify(entries));
  assert.ok(existsSync(join(cache, 'plugins', key, 'claude', entries.find((e) => !e.includes('.'))!, 'reports.json')));
});
