/**
 * Pi translation boundaries that do not require a running harness.
 *
 * Usage: node check-adapter.ts SRC HARNESS_DIR
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { writeConfig, mergeState } = await import(join(process.argv[2], 'harness/pi.ts'));

const temporary = () => mkdtempSync(join(tmpdir(), 'pi-adapter-'));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const snapshot = (path: string) => {
  const stat = statSync(path, { bigint: true });
  return [readFileSync(path, 'utf8'), stat.ino, stat.mtimeNs];
};

function captureStderr(action: () => void): string {
  let stderr = '';
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => (stderr += chunk, true)) as typeof process.stderr.write;
  try {
    action();
  } finally {
    process.stderr.write = write;
  }
  return stderr;
}

test('translation and skipped transports', () => {
  const root = temporary();
  mkdirSync(join(root, 'skills/guide'), { recursive: true });
  writeFileSync(join(root, 'skills/guide/SKILL.md'), 'Guide');
  symlinkSync('SKILL.md', join(root, 'skills/guide/approved'));
  writeFileSync(join(root, 'skills/guide/unapproved'), 'Do not copy');
  const description = join(root, 'description.json');
  writeFileSync(description, JSON.stringify({
    version: '1.0.0', root, manifest: { name: 'example' },
    skills: { guide: ['SKILL.md', 'approved'] },
    mcpServers: {
      local: { type: 'stdio', command: './server', args: [], env: {} },
      http: { type: 'streamable-http', url: 'https://example.test/mcp', headers: {} },
      sse: { type: 'sse', url: 'https://example.test/sse', headers: {} },
      equals: { type: 'stdio', command: 'bad=command', args: [], env: {} },
    },
  }));
  const gateway = { url: 'https://gateway.test/', keyEnv: 'TEST_KEY', models: { large: 'large', small: 'small' } };
  const args = (name: string, ...descriptions: string[]) => {
    const path = join(root, `${name}.json`);
    writeFileSync(path, JSON.stringify({ bash: '/bin/sh', env: '/usr/bin/env', gateway, descriptions }));
    return path;
  };

  const out = join(root, 'out-pi-config');
  const diagnostics = captureStderr(() => writeConfig(out, args('single', description)));
  const config = readJson(join(out, 'config.json'));
  assert.deepEqual(new Set(Object.keys(config.mcpServers)), new Set(['local', 'http']));
  assert.ok(diagnostics.includes('Pi does not support SSE'), diagnostics);
  assert.ok(diagnostics.includes('command containing "="'), diagnostics);
  const local = config.mcpServers.local;
  assert.deepEqual(Object.keys(local), ['command']);
  assert.ok(readFileSync(local.command, 'utf8').includes('PLUGIN_ROOT='));
  const skills = join(config.skills[0], 'guide');
  assert.ok(!lstatSync(join(skills, 'approved')).isSymbolicLink());
  assert.equal(readFileSync(join(skills, 'approved'), 'utf8'), 'Guide');
  assert.ok(!existsSync(join(skills, 'unapproved')));
  const provider = readJson(join(out, 'gateway.json')).providers.litellm;
  assert.equal(provider.apiKey, '$TEST_KEY');
  assert.equal(provider.baseUrl, 'https://gateway.test/v1');
  assert.deepEqual(provider.models, [{ id: 'large' }, { id: 'small' }]);
  assert.throws(() => writeConfig(join(root, 'collision'), args('double', description, description)), /declared by both/);
});

test('empty contributions keep settings default', () => {
  const root = temporary();
  const fragment = join(root, 'fragment.json');
  writeFileSync(fragment, JSON.stringify({ skills: [], mcpServers: {} }));
  const agent = join(root, 'agent');
  mergeState('--check', agent, fragment);
  assert.ok(!existsSync(join(agent, 'settings.json')));
  // The thinking-block default is always written, even for an empty
  // contribution set, so a fresh merge creates settings.json only.
  mergeState('--merge', agent, fragment);
  assert.deepEqual(readJson(join(agent, 'settings.json')), { hideThinkingBlock: true });
  writeFileSync(join(agent, 'mcp.json'), '{}');
  const before = new Map(readdirSync(agent).map((name) => [name, snapshot(join(agent, name))]));
  for (const mode of ['--check', '--merge']) {
    mergeState(mode, agent, fragment);
    for (const [name, original] of before) assert.deepEqual(snapshot(join(agent, name)), original);
  }
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({
    skills: ['/personal/skills', '/nix/store/old-pi-config/skills/example'],
  }));
  mergeState('--merge', agent, fragment);
  assert.deepEqual(readJson(join(agent, 'settings.json')), { skills: ['/personal/skills'], hideThinkingBlock: true });
  writeFileSync(join(agent, 'settings.json'), '{');
  assert.throws(() => mergeState('--merge', agent, fragment));
  assert.equal(readFileSync(join(agent, 'settings.json'), 'utf8'), '{');
});

test('only contributing files are created', () => {
  const root = temporary();
  const fragment = join(root, 'fragment.json');
  // The thinking-block default lives in settings.json, so that file
  // exists whenever anything (or nothing else) is merged.
  for (const [name, contribution] of [
    ['settings', { skills: ['/managed/skills'], mcpServers: {} }],
    ['mcp', { skills: [], mcpServers: { managed: { command: '/server' } } }],
  ] as const) {
    writeFileSync(fragment, JSON.stringify(contribution));
    const agent = join(root, name);
    mergeState('--merge', agent, fragment);
    const expected = name === 'settings' ? ['settings.json'] : ['mcp.json', 'settings.json'];
    assert.deepEqual(readdirSync(agent).sort(), expected);
  }
});

test('atomic preservation and validation', () => {
  const root = temporary();
  const fragment = join(root, 'fragment.json');
  writeFileSync(fragment, JSON.stringify({
    skills: ['/nix/store/new-pi-config/skills/example'],
    mcpServers: { managed: { command: '/new/server' } },
  }));
  const mcp = join(root, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { personal: { command: '/personal' }, managed: { command: '/old/server' } } }));
  chmodSync(mcp, 0o640);
  const settings = join(root, 'settings.json');
  writeFileSync(settings, JSON.stringify({
    skills: ['/personal/skills', '/nix/store/old-pi-config/skills/example'], theme: 'light',
  }));
  const before = statSync(mcp).ino;
  mergeState('--merge', root, fragment);
  assert.notEqual(statSync(mcp).ino, before);
  assert.equal(statSync(mcp).mode & 0o777, 0o640);
  assert.deepEqual(readJson(mcp).mcpServers, { personal: { command: '/personal' }, managed: { command: '/new/server' } });
  assert.deepEqual(readJson(settings), {
    skills: ['/personal/skills', '/nix/store/new-pi-config/skills/example'], theme: 'light', hideThinkingBlock: true,
  });
  const inode = statSync(mcp).ino;
  mergeState('--merge', root, fragment);
  assert.equal(statSync(mcp).ino, inode);
  const content = readFileSync(mcp, 'utf8');
  writeFileSync(settings, '{');
  assert.throws(() => mergeState('--merge', root, fragment));
  assert.equal(readFileSync(mcp, 'utf8'), content);
  assert.equal(readFileSync(settings, 'utf8'), '{');
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.pi-')), []);
});
