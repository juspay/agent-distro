/**
 * The Antigravity CLI's translation and its links into a home, without the
 * harness: what is written, what the next launch takes back, a user's own
 * plugin left alone, and a home that cannot be written.
 *
 * Usage: node check-adapter.ts SRC HARNESS_DIR
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The module's path is the SRC argument, so it cannot be a static import.
const { adapter, link, RECORD } = await import(join(process.argv[2], 'harness/agy.ts'));
const { LaunchError } = await import(join(process.argv[2], 'plugin/launch.ts'));

const temporary = () => mkdtempSync(join(tmpdir(), 'agy-adapter-'));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const inputs = { bash: '/bin/sh', env: '/usr/bin/env' };

/** What a launch hands the adapter for each plugin: its name and translation. */
const plugin = (name: string, translation: string) => ({ name, translation, from: 'profile' });

/** Run `body` with stderr captured; what it wrote, and what it returned. */
function quietly<T>(body: () => T): [T, string] {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    return [body(), written.join('')];
  } finally {
    process.stderr.write = write;
  }
}

/** Run `body` with HOME set to `home` (or unset), restoring it after. */
function withHome<T>(home: string | undefined, body: () => T): T {
  const saved = process.env.HOME;
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
}

test('a plugin becomes an Antigravity plugin folder', () => {
  const root = temporary();
  mkdirSync(join(root, 'skills/guide'), { recursive: true });
  writeFileSync(join(root, 'skills/guide/SKILL.md'), 'Guide');
  writeFileSync(join(root, 'skills/guide/unapproved'), 'Do not copy');
  const description = {
    version: '1.0.0', root,
    manifest: {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'example',
      version: '1.2.0', description: 'An example', author: { name: 'Someone' }, keywords: ['x'],
    },
    skills: { guide: ['SKILL.md'] },
    mcpServers: {
      local: { type: 'stdio', command: './server', args: [], env: {} },
      http: { type: 'streamable-http', url: 'https://example.test/mcp', headers: { 'X-Key': 'v' } },
      sse: { type: 'sse', url: 'https://example.test/sse', headers: {} },
      equals: { type: 'stdio', command: 'bad=command', args: [], env: {} },
    },
  };
  const out = join(temporary(), 'out');
  const reports: string[] = [];
  adapter.translate(description, out, inputs, (message: string) => reports.push(message));

  // Antigravity's own schema, over the manifest's fields, which are all its too.
  assert.deepEqual(readJson(join(out, 'plugin.json')), {
    $schema: 'https://antigravity.google/schemas/v1/plugin.json', name: 'example',
    version: '1.2.0', description: 'An example', author: { name: 'Someone' }, keywords: ['x'],
  });
  assert.equal(readFileSync(join(out, 'skills/guide/SKILL.md'), 'utf8'), 'Guide');
  assert.ok(!existsSync(join(out, 'skills/guide/unapproved')));

  const servers = readJson(join(out, 'mcp_config.json')).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ['http', 'local']);
  assert.deepEqual(servers.http, { serverUrl: 'https://example.test/mcp', headers: { 'X-Key': 'v' } });
  // A stdio server runs through a generated launcher, by absolute path.
  assert.deepEqual(Object.keys(servers.local), ['command', 'args']);
  assert.ok(servers.local.command.startsWith(out + '/'), servers.local.command);
  assert.ok(readFileSync(servers.local.command, 'utf8').includes('PLUGIN_ROOT='));
  // What cannot be carried is said.
  assert.ok(reports.some((line) => line.includes('"sse" skipped, Antigravity does not support SSE')), reports.join('\n'));
  assert.ok(reports.some((line) => line.includes('"equals" skipped') && line.includes('"="')), reports.join('\n'));

  // A plugin with no servers has no mcp_config.json.
  const bare = join(temporary(), 'out');
  adapter.translate({ ...description, mcpServers: {} }, bare, inputs, () => {});
  assert.ok(!existsSync(join(bare, 'mcp_config.json')));
});

test('links last one launch, and a user\'s own folders are never touched', () => {
  const home = temporary();
  const plugins = join(home, '.gemini/config/plugins');
  const record = join(home, '.gemini/config', RECORD);
  const [a, b, c] = ['a', 'b', 'c'].map(() => temporary());
  mkdirSync(join(plugins, 'mine'), { recursive: true });
  writeFileSync(join(plugins, 'mine/plugin.json'), '{"name":"mine"}');
  const reports: string[] = [];
  const launch = (...list: [string, string][]) => withHome(home, () =>
    adapter.launch({ args: inputs, plugins: list.map(([name, at]) => plugin(name, at)), cache: null, report: (m: string) => reports.push(m) }));
  const listed = () => Object.fromEntries(readdirSync(plugins).sort().map((name) => {
    const path = join(plugins, name);
    return [name, lstatSync(path).isSymbolicLink() ? readlinkSync(path) : 'dir'];
  }));

  assert.equal(launch(['alpha', a], ['beta', b]), '');
  assert.deepEqual(listed(), { alpha: a, beta: b, mine: 'dir' });
  assert.deepEqual(readJson(record), { links: { alpha: a, beta: b } });

  // The next launch takes back what it no longer wants and keeps what it does.
  launch(['beta', b], ['gamma', c]);
  assert.deepEqual(listed(), { beta: b, gamma: c, mine: 'dir' });
  assert.deepEqual(readJson(record), { links: { beta: b, gamma: c } });

  // A new translation of the same plugin replaces its link.
  launch(['beta', a]);
  assert.deepEqual(listed(), { beta: a, mine: 'dir' });

  // A plugin whose name a user's folder holds is skipped, with a word.
  launch(['mine', a]);
  assert.deepEqual(listed(), { mine: 'dir' });
  assert.equal(readFileSync(join(plugins, 'mine/plugin.json'), 'utf8'), '{"name":"mine"}');
  assert.ok(reports.some((line) => line.includes('plugin "mine" skipped')), reports.join('\n'));
  assert.ok(!existsSync(record), 'nothing linked, nothing recorded');

  // A link the user changed after the launch made it is theirs now: it stays,
  // and the record forgets it.
  launch(['alpha', a]);
  rmSync(join(plugins, 'alpha'));
  symlinkSync(b, join(plugins, 'alpha'));
  launch();
  assert.deepEqual(listed(), { alpha: b, mine: 'dir' });
  assert.ok(!existsSync(record));

  // A launch with nothing to take back writes nothing at all.
  const fresh = temporary();
  withHome(fresh, () => adapter.launch({ args: inputs, plugins: [], cache: null, report: () => {} }));
  assert.deepEqual(readdirSync(fresh), []);
});

test('a record that is not ours stops the launch before any change', () => {
  const home = temporary();
  const config = join(home, '.gemini/config');
  mkdirSync(join(config, 'plugins'), { recursive: true });
  writeFileSync(join(config, RECORD), '[]');
  assert.throws(() => link(join(config, 'plugins'), join(config, RECORD), { alpha: temporary() }, () => {}),
    (error: Error) => error instanceof LaunchError && /not agent-distro's launch record/.test(error.message));
  assert.deepEqual(readdirSync(join(config, 'plugins')), []);
});

test('a home that is unset or cannot be written skips the links and still launches', () => {
  const translation = temporary();
  const launch = () => adapter.launch({ args: inputs, plugins: [plugin('alpha', translation)], cache: null, report: () => {} });

  const [unset, said] = quietly(() => withHome(undefined, launch));
  assert.equal(unset, '');
  assert.match(said, /HOME is unset; skipping plugin links/);

  const home = temporary();
  mkdirSync(join(home, '.gemini/config'), { recursive: true });
  chmodSync(join(home, '.gemini/config'), 0o500);
  try {
    const [readOnly, warned] = quietly(() => withHome(home, launch));
    assert.equal(readOnly, '');
    assert.match(warned, /cannot be written; skipping plugin links/);
    assert.deepEqual(readdirSync(join(home, '.gemini/config')), []);
  } finally {
    chmodSync(join(home, '.gemini/config'), 0o700);
  }
});
