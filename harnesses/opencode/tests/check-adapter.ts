/**
 * Adapter policy checks without starting OpenCode or reaching a gateway.
 *
 * Usage: node check-adapter.ts SRC HARNESS_DIR
 */
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

const [src, adapter] = process.argv.slice(2);
const temporary = () => mkdtempSync(join(tmpdir(), 'opencode-adapter-'));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

for (const schema of ['v1', 'v2'] as const) {
  const providerKey = schema === 'v2' ? 'providers' : 'provider';
  const settingsKey = schema === 'v2' ? 'settings' : 'options';
  const shape = join(dirname(adapter), schema === 'v2' ? 'opencode2' : 'opencode', 'gateway-shape.json');

  function writeConfig(out: string, gateway: unknown, descriptions: string[], options: SpawnSyncOptions = {}) {
    const args = out + '.args.json';
    writeFileSync(args, JSON.stringify({ schema, bash: '/bin/sh', env: '/usr/bin/env', gateway, descriptions }));
    return spawnSync(process.execPath, [join(src, 'harness/opencode.ts'), out, args], { encoding: 'utf8', ...options });
  }

  describe(`OpenCode ${schema}`, () => {
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
      const result = writeConfig(out, null, [first]);
      assert.equal(result.status, 0, String(result.stderr));
      const config = readJson(join(out, 'opencode.json'));
      const servers = schema === 'v2' ? config.mcp.servers : config.mcp;
      assert.deepEqual(Object.keys(servers), ['shared']);
      assert.deepEqual(config.skills, schema === 'v2' ? [] : { paths: [] });
      for (const server of [local, remote]) {
        const second = description('second-plugin', server);
        [[first, second], [second, first]].forEach((order, index) => {
          const collision = writeConfig(join(root, `collision-${server.type}-${index}`), null, order);
          assert.notEqual(collision.status, 0);
          for (const expected of ['MCP server "shared"', '"first-plugin"', '"second-plugin"']) {
            assert.ok(String(collision.stderr).includes(expected), String(collision.stderr));
          }
        });
      }
    });

    test('credentials and fallbacks', () => {
      const root = temporary();
      const base = join(root, 'base.json');
      const cache = join(root, 'cache/opencode.json');
      const provider: Record<string, any> = {
        [settingsKey]: { baseURL: 'https://gateway.example/v1' },
        models: { large: { name: 'large' }, small: { name: 'small' } },
      };
      if (schema === 'v2') provider.env = ['TEST_KEY'];
      else provider.options.apiKey = '{env:TEST_KEY}';
      writeFileSync(base, JSON.stringify({ [providerKey]: { litellm: provider } }));
      const key = 'test"key\\value';
      // A stand-in curl: records its argv and stdin, then answers or fails.
      const curl = join(root, 'curl');
      writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.argv"\ncat > "$0.stdin"\n`
        + `[ -e "$0.down" ] && exit 7\necho '{"data":[{"id":"served"}]}'\n`);
      chmodSync(curl, 0o755);

      const invoke = () => {
        const result = spawnSync(process.execPath, [join(src, 'gateway/models.ts'), base, cache, curl, 'TEST_KEY', shape],
          { encoding: 'utf8', env: { ...process.env, TEST_KEY: key } });
        assert.equal(result.status, 0, result.stderr);
        return [result.stdout.trim(), result.stderr];
      };

      let [selected, warning] = invoke();
      const argv = readFileSync(curl + '.argv', 'utf8').split('\n');
      assert.ok(!argv.join(' ').includes(key));
      assert.ok(!argv.includes('--header'));
      assert.equal(argv[argv.indexOf('--config') + 1], '-');
      assert.equal(readFileSync(curl + '.stdin', 'utf8'), 'header = "Authorization: Bearer test\\"key\\\\value"\n');
      assert.equal(selected, cache);
      assert.equal(warning, '');
      const saved = readFileSync(cache, 'utf8');
      assert.ok(!saved.includes(key));
      assert.deepEqual(new Set(Object.keys(JSON.parse(saved)[providerKey].litellm.models)), new Set(['served', 'large', 'small']));

      writeFileSync(curl + '.down', '');
      [selected, warning] = invoke();
      assert.equal(selected, cache);
      assert.ok(warning.includes(`cached model list from ${cache}`), warning);
      assert.equal(warning.trimEnd().split('\n').length, 1, warning);
      assert.ok(!warning.includes(key));
      assert.equal(readFileSync(cache, 'utf8'), saved);
      rmSync(cache);
      [selected, warning] = invoke();
      assert.equal(selected, base);
      assert.ok(warning.includes(`two profile aliases from ${base}`), warning);
      assert.equal(warning.trimEnd().split('\n').length, 1, warning);
    });

    test('gateway and materialized skills', () => {
      const root = temporary();
      const source = join(root, 'skills/guide');
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, 'SKILL.md'), '---\nname: guide\ndescription: Guide\n---\nRead me.\n');
      const gateway = { url: 'https://gateway.example/', keyEnv: 'TEST_KEY', models: { large: 'large', small: 'small' } };
      const description = join(root, 'plugin.json');
      writeFileSync(description, JSON.stringify({
        root, manifest: { name: 'example' }, skills: { guide: ['SKILL.md'] },
        mcpServers: {
          remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer {env:TOKEN}' } },
        },
      }));
      const out = join(root, 'out');
      assert.equal(writeConfig(out, gateway, [description]).status, 0);
      const plain = readJson(join(out, 'opencode.json'));
      assert.ok(!(providerKey in plain));
      const paths = schema === 'v2' ? plain.skills : plain.skills.paths;
      assert.deepEqual(paths, [join(out, 'skills/example')]);
      assert.equal(readFileSync(join(paths[0], 'guide/SKILL.md'), 'utf8'), readFileSync(join(source, 'SKILL.md'), 'utf8'));
      const servers = schema === 'v2' ? plain.mcp.servers : plain.mcp;
      assert.equal(servers.remote.type, 'remote');
      const config = readJson(join(out, 'gateway.json'));
      const provider = config[providerKey].litellm;
      assert.deepEqual(new Set(Object.keys(provider.models)), new Set(['large', 'small']));
      assert.equal(provider[settingsKey].baseURL, 'https://gateway.example/v1');
      assert.equal(config.model, 'litellm/large');
      if (schema === 'v2') {
        assert.deepEqual(provider.env, ['TEST_KEY']);
        assert.equal(provider.package, '@opencode/ai/providers/openai-compatible');
        assert.ok(!('small_model' in config));
        assert.ok(!('provider' in config));
        assert.ok(!('apiKey' in provider.settings));
      } else {
        assert.equal(provider.npm, '@ai-sdk/openai-compatible');
        assert.equal(provider.options.apiKey, '{env:TEST_KEY}');
        assert.equal(config.small_model, 'litellm/small');
      }
      assert.ok(existsSync(join(out, 'bin')));
    });
  });
}
