/**
 * Pi translation boundaries that do not require a running harness.
 *
 * Usage: node check-adapter.ts SRC HARNESS_DIR
 */
import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { writeConfig, mergeState } = await import(join(process.argv[2], 'harness/pi.ts'));

const temporary = () => mkdtempSync(join(tmpdir(), 'pi-adapter-'));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const snapshot = (path: string) => {
  // One access: an open that hands back the descriptor every later step uses,
  // so the content and the inode it is compared with cannot race apart.
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd, { bigint: true });
    return [readFileSync(fd, 'utf8'), stat.ino, stat.mtimeNs] as const;
  } finally {
    closeSync(fd);
  }
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
  const content = snapshot(mcp)[0];
  writeFileSync(settings, '{');
  assert.throws(() => mergeState('--merge', root, fragment));
  assert.equal(snapshot(mcp)[0], content);
  assert.equal(readFileSync(settings, 'utf8'), '{');
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.pi-')), []);
});

test('plugins from AGENT_DISTRO_PLUGINS last one launch', () => {
  const agent = temporary();
  const write = (name: string, fragment: unknown) => {
    const path = join(agent, `${name}.fragment`);
    writeFileSync(path, JSON.stringify(fragment));
    return path;
  };
  const profileServer = { command: '/nix/store/x-pi-config/bin/kolu-0-kolu' };
  const profile = write('profile', {
    skills: ['/nix/store/x-pi-config/skills/kolu'], mcpServers: { kolu: profileServer },
  });
  const launchServer = { command: '/cache/kolu/bin/kolu-0-kolu' };
  const launched = write('launch', {
    skills: ['/cache/kolu/skills/kolu', '/cache/extra/skills/extra'],
    mcpServers: { kolu: launchServer, remote: { url: 'https://example.test/mcp', headers: {} } },
    launch: {
      skills: ['/cache/kolu/skills/kolu', '/cache/extra/skills/extra'],
      mcpServers: ['kolu', 'remote'],
      replaces: { kolu: profileServer },
    },
  });
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { personal: { command: '/personal' } } }));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ skills: ['/personal/skills'] }));
  const servers = () => readJson(join(agent, 'mcp.json')).mcpServers;
  const skills = () => readJson(join(agent, 'settings.json')).skills;

  mergeState('--merge', agent, profile);
  const steady = [servers(), skills()];
  mergeState('--check', agent, launched);
  assert.deepEqual([servers(), skills()], steady, '--check writes nothing');
  assert.ok(!existsSync(join(agent, '.agent-distro-launch.json')));

  mergeState('--merge', agent, launched);
  assert.deepEqual(servers(), { personal: { command: '/personal' }, kolu: launchServer, remote: { url: 'https://example.test/mcp', headers: {} } });
  assert.deepEqual(skills(), ['/personal/skills', '/cache/kolu/skills/kolu', '/cache/extra/skills/extra']);
  const record = snapshot(join(agent, '.agent-distro-launch.json'));
  mergeState('--merge', agent, launched);
  assert.deepEqual(snapshot(join(agent, '.agent-distro-launch.json')), record, 'a steady launch rewrites nothing');

  // Unset: the profile's own entries are back, and nothing of the launch remains.
  mergeState('--merge', agent, profile);
  assert.deepEqual([servers(), skills()], steady);
  assert.ok(!existsSync(join(agent, '.agent-distro-launch.json')));

  // A launch entry the user has since edited is theirs to keep.
  mergeState('--merge', agent, launched);
  const mcp = readJson(join(agent, 'mcp.json'));
  mcp.mcpServers.remote.headers = { Authorization: 'mine' };
  writeFileSync(join(agent, 'mcp.json'), JSON.stringify(mcp));
  mergeState('--merge', agent, profile);
  assert.deepEqual(servers().remote, { url: 'https://example.test/mcp', headers: { Authorization: 'mine' } });
  assert.deepEqual(servers().kolu, profileServer);

  writeFileSync(join(agent, '.agent-distro-launch.json'), '[]');
  assert.throws(() => mergeState('--merge', agent, profile), /not a launch record|JSON object/);
});

test('a launch with plugins needs a home; one without is the profile', async () => {
  const { adapter } = await import(join(process.argv[2], 'harness/pi.ts'));
  const config = temporary();
  writeFileSync(join(config, 'config.json'), JSON.stringify({ skills: [], mcpServers: {} }));
  const launch = { args: { config, profile: [] }, kept: [], replaced: [], rest: [], cache: null, report: () => {} };
  assert.equal(adapter.launch({ ...launch, plugins: [] }), join(config, 'config.json'));
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  delete process.env.HOME;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    assert.throws(() => adapter.launch({ ...launch, cache: temporary(), plugins: [{ name: 'p' }] }),
      /HOME and PI_CODING_AGENT_DIR are unset/);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
  }
});
