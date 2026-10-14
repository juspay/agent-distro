/**
 * Adapter policy checks without starting OpenCode or reaching a LiteLLM
 * server: the session config's own contents, the profile's `settings.opencode`
 * merged over it at launch, and the session defaults.
 *
 * Usage: node check-adapter.ts SRC HARNESS_DIR
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

const [src] = process.argv.slice(2);
const temporary = () => mkdtempSync(join(tmpdir(), 'opencode-adapter-'));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

// The vendored opencode-plugin-litellm, as harnesses/opencode/default.nix
// names it: the session config loads it on every launch.
const PLUGIN = '/nix/store/example-opencode-plugin-litellm/src';

function writeConfig(out: string, descriptions: string[]) {
  const args = out + '.args.json';
  writeFileSync(args, JSON.stringify({ bash: '/bin/sh', env: '/usr/bin/env', plugin: PLUGIN, descriptions }));
  return spawnSync(process.execPath, [join(src, 'harness/opencode.ts'), out, args], { encoding: 'utf8' });
}

/** The session config with a profile's `settings.opencode` merged over it, as the launcher does it. */
function mergeSettings(base: string, settings: unknown, cache: string) {
  return spawnSync(process.execPath,
    [join(src, 'harness/opencode-settings.ts'), base, JSON.stringify(settings), cache], { encoding: 'utf8' });
}

describe('OpenCode', () => {
  test('server names and collisions', () => {
    const local = { type: 'stdio', command: 'echo', args: [], env: {} };
    const remote = { type: 'streamable-http', url: 'https://example.com/mcp', headers: {} };
    const root = temporary();
    const description = (plugin: string, server: unknown) => {
      const path = join(root, `${plugin}.json`);
      writeFileSync(path, JSON.stringify({
        version: '1.0.0', root, manifest: { name: plugin }, skills: {}, mcpServers: { shared: server },
      }));
      return path;
    };
    const first = description('first-plugin', local);
    const out = join(root, 'valid');
    const result = writeConfig(out, [first]);
    assert.equal(result.status, 0, String(result.stderr));
    const config = readJson(join(out, 'opencode.json'));
    assert.deepEqual(Object.keys(config.mcp.servers), ['shared']);
    assert.deepEqual(config.skills, []);
    for (const server of [local, remote]) {
      const second = description('second-plugin', server);
      [[first, second], [second, first]].forEach((order, index) => {
        const collision = writeConfig(join(root, `collision-${server.type}-${index}`), order);
        assert.notEqual(collision.status, 0);
        for (const expected of ['MCP server "shared"', '"first-plugin"', '"second-plugin"']) {
          assert.ok(String(collision.stderr).includes(expected), String(collision.stderr));
        }
      });
    }
  });

  test('the vendored plugin, materialized skills and the profile\'s settings', () => {
    const root = temporary();
    const source = join(root, 'skills/guide');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: guide\ndescription: Guide\n---\nRead me.\n');
    const description = join(root, 'plugin.json');
    writeFileSync(description, JSON.stringify({
      root, manifest: { name: 'example' }, skills: { guide: ['SKILL.md'] },
      mcpServers: {
        remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer {env:TOKEN}' } },
      },
    }));
    const out = join(root, 'out');
    assert.equal(writeConfig(out, [description]).status, 0);
    const plain = readJson(join(out, 'opencode.json'));
    // The plugin that discovers a LiteLLM server's models is loaded by every
    // launch, profile or not, and nothing names a provider yet.
    assert.deepEqual(plain.plugins, [PLUGIN]);
    assert.ok(!('providers' in plain));
    assert.deepEqual(plain.skills, [join(out, 'skills/example')]);
    const skills = plain.skills[0];
    assert.equal(readFileSync(join(skills, 'guide/SKILL.md'), 'utf8'), readFileSync(join(source, 'SKILL.md'), 'utf8'));
    assert.equal(plain.mcp.servers.remote.type, 'remote');
    assert.ok(existsSync(join(out, 'bin')));
    // The profile's `settings.opencode` is merged over the session config at
    // launch: a provider it names, and the models it points at.
    const cache = join(root, 'cache');
    const settings = {
      providers: { litellm: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://gateway.example/v1' } } },
      model: 'litellm/large',
      agents: { title: { model: 'litellm/small' } },
      plugins: ['opencode-plugin-litellm@1.4.3'],
      skills: ['/from/the/profile'],
      mcp: { servers: { profile: { type: 'remote', url: 'https://profile.example/mcp' } }, timeout: 30 },
    };
    const merged = mergeSettings(join(out, 'opencode.json'), settings, cache);
    assert.equal(merged.status, 0, merged.stderr);
    const written = merged.stdout.trim();
    assert.equal(dirname(written), cache);
    const config = readJson(written);
    // Objects merge key-wise, so the launcher's own document is not replaced.
    assert.equal(config.$schema, 'https://opencode.ai/config.json');
    assert.deepEqual(config.providers, settings.providers);
    assert.equal(config.model, 'litellm/large');
    assert.deepEqual(config.agents, { title: { model: 'litellm/small' } });
    // A profile's plugins come after the vendored one: OpenCode concatenates
    // `plugins` across config files, and this document's entry is the session's.
    assert.deepEqual(config.plugins, [PLUGIN, 'opencode-plugin-litellm@1.4.3']);
    // `skills` and `mcp.servers` are the launcher's own — they name what this
    // launch's plugins resolved to — while the rest of `mcp` is the profile's.
    assert.deepEqual(config.skills, plain.skills);
    assert.deepEqual(config.mcp.servers, plain.mcp.servers);
    assert.equal(config.mcp.timeout, 30);
    // Nothing here is a key: the launcher exports LITELLM_API_KEY for the
    // plugin to read, and the plugin reads it from the environment.
    assert.ok(!readFileSync(written, 'utf8').includes('TEST_KEY'));
    // The merge is content-addressed, and reading it twice writes nothing new.
    assert.equal(mergeSettings(join(out, 'opencode.json'), settings, cache).stdout.trim(), written);
    // A profile with no settings for OpenCode is the session config itself.
    assert.deepEqual(readJson(mergeSettings(join(out, 'opencode.json'), {}, cache).stdout.trim()), plain);
  });

  test('the session defaults decide a terminal session', () => {
    const defaults = join(process.argv[3], 'session-defaults.sh');
    // The launcher sources this and then execs the harness with what it
    // decided; this is that decision, without building a launcher. An
    // argument-free launch is the case the `opencode-standalone` check builds
    // a launcher for.
    const probe = join(temporary(), 'session.sh');
    writeFileSync(probe, `set -eu\n. ${defaults}\nprintf '%s\\n' "$*"\n`);
    const session = (...args: string[]) => {
      const result = spawnSync('bash', [probe, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trimEnd();
    };
    const project = temporary();
    const missing = join(temporary(), 'missing');
    assert.equal(session(), '--standalone');
    assert.equal(session(project), `--standalone ${project}`);
    // An explicit mode, two positionals, a path that is not a directory, or
    // --help: the arguments stand as they were.
    assert.equal(session('--standalone', '--prompt', 'hi'), '--standalone --prompt hi');
    assert.equal(session('one', 'two'), 'one two');
    assert.equal(session(missing), missing);
    assert.equal(session('--help'), '--help');
  });

  test('a launch merge lands the plugin\'s skills and servers', async () => {
    const { adapter } = await import(join(src, 'harness/opencode.ts'));
    const root = temporary();
    const config = join(root, 'config');
    mkdirSync(config, { recursive: true });
    mkdirSync(join(root, 'skills/guide'), { recursive: true });
    writeFileSync(join(root, 'skills/guide/SKILL.md'), '---\nname: guide\ndescription: Guide\n---\nRead me.\n');
    writeFileSync(join(config, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json', skills: [], mcp: { servers: {} },
    }));
    const description = {
      root, manifest: { name: 'example' }, skills: { guide: ['SKILL.md'] },
      mcpServers: { local: { type: 'stdio', command: 'echo', args: [], env: {} } },
    };
    const translation = join(root, 'translation');
    adapter.translate(description, translation, { bash: '/bin/sh', env: '/usr/bin/env' }, () => {});
    const launch = {
      args: { config, name: 'opencode', profile: [] }, kept: [], replaced: [], cache: join(root, 'cache'),
      report: () => {},
    };
    // No plugins to add: the launcher's own config stands.
    assert.equal(adapter.launch({ ...launch, plugins: [] }), join(config, 'opencode.json'));
    const merged = readJson(adapter.launch({ ...launch, plugins: [{ name: 'example', description, translation }] })!);
    assert.deepEqual(merged.skills, [join(translation, 'skills/example')]);
    assert.equal(merged.mcp.servers.local.type, 'local');
    assert.ok(merged.mcp.servers.local.command[0].includes('translation'), merged.mcp.servers.local);
  });
});
