/**
 * Unit checks for src/plugin/read.ts: no VM, no harness.
 *
 * Usage: node check-read-plugin.ts READER
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const reader = process.argv[2];
const PLUGIN = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const work = mkdtempSync(join(tmpdir(), 'read-plugin-'));
let count = 0;

type Files = Record<string, unknown>;

/** A plugin directory; values are JSON-encoded unless they are strings. */
function plugin(manifest?: unknown, files: Files = {}): string {
  const root = join(work, `p${++count}`);
  mkdirSync(root);
  const write = (path: string, content: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  };
  if (manifest !== undefined) write('plugin.json', manifest);
  for (const [path, content] of Object.entries(files)) write(path, content);
  return root;
}

function read(root: string) {
  const result = spawnSync(process.execPath, [reader, root], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fatal(root: string, field: string) {
  const { code, stdout, stderr } = read(root);
  assert.ok(code === 1 && !stdout, `${root}: ${code} ${stdout} ${stderr}`);
  assert.ok(stderr.includes('invalid Agent Plugin') && stderr.includes(field), `${field}: ${stderr}`);
}

type Schema = Record<string, any>;
const schema: Schema = JSON.parse(readFileSync(join(dirname(reader), 'description.schema.json'), 'utf8'));

/** The JSON Schema keywords description.schema.json uses, and no more. */
function validate(value: any, rule: Schema, at = '$'): void {
  const fail = (message: string) => assert.fail(`${at}: ${message}: ${JSON.stringify(value)}`);
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (rule.type && rule.type !== kind) fail(`not ${rule.type}`);
  if ('const' in rule && value !== rule.const) fail(`not ${rule.const}`);
  if (rule.enum && !rule.enum.includes(value)) fail(`not one of ${rule.enum}`);
  if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail(`does not match ${rule.pattern}`);
  if (rule.minLength !== undefined && value.length < rule.minLength) fail('too short');
  if (rule.maxLength !== undefined && value.length > rule.maxLength) fail('too long');
  if (rule.items) value.forEach((item: any, i: number) => validate(item, rule.items, `${at}[${i}]`));
  if (rule.oneOf) {
    const passing = rule.oneOf.filter((option: Schema) => {
      try {
        validate(value, option, at);
        return true;
      } catch {
        return false;
      }
    });
    if (passing.length !== 1) fail(`matches ${passing.length} of oneOf`);
  }
  if (kind !== 'object') return;
  for (const key of rule.required ?? []) if (!(key in value)) fail(`lacks ${key}`);
  for (const [key, needs] of Object.entries(rule.dependentRequired ?? {})) {
    if (key in value) for (const need of needs as string[]) if (!(need in value)) fail(`${key} without ${need}`);
  }
  for (const [key, item] of Object.entries(value)) {
    const property = rule.properties?.[key] ?? rule.additionalProperties;
    if (property === false) fail(`unexpected ${key}`);
    if (property && property !== true) validate(item, property, `${at}.${key}`);
  }
}

function ok(root: string) {
  const { code, stdout, stderr } = read(root);
  assert.equal(code, 0, `${root}: ${stderr}`);
  const description = JSON.parse(stdout);
  // Every description the reader writes is one description.schema.json allows.
  validate(description, schema);
  // Every report is in both the description and the build log.
  for (const r of description.reports) assert.ok(stderr.includes(r), stderr);
  return description;
}

const minimal = (fields: Record<string, unknown> = {}) => ({ $schema: PLUGIN, name: 'p', ...fields });
const servers = (mcpServers: unknown, extra: Record<string, unknown> = {}) =>
  ok(plugin(minimal(), { 'mcp.json': { $schema: MCP, mcpServers, ...extra } }));

// §5: fatal manifest violations name the field.
fatal(plugin(), 'plugin.json is missing');
fatal(plugin('{'), 'not valid JSON');
fatal(plugin([]), 'JSON object');
fatal(plugin({ name: 'p' }), '`$schema` is missing');
fatal(plugin({ $schema: PLUGIN.replace('1.0.0', '9.0.0'), name: 'p' }), '`$schema`');
fatal(plugin({ $schema: [PLUGIN], name: 'p' }), '`$schema`');
fatal(plugin({ $schema: PLUGIN }), '`name` is missing');
for (const name of ['My-Plugin', '-start', 'end-', 'has--double', 'too.many..dots', '', 'a'.repeat(65), 5, null]) {
  fatal(plugin(minimal({ name })), '`name`');
}
for (const field of ['version', 'description', 'homepage', 'repository', 'license']) {
  fatal(plugin(minimal({ [field]: 1 })), `\`${field}\``);
}
fatal(plugin(minimal({ author: 'someone' })), '`author`');
fatal(plugin(minimal({ author: { name: 'a', twitter: 'b' } })), '`author.twitter`');
fatal(plugin(minimal({ author: { email: 1 } })), '`author.email`');
fatal(plugin(minimal({ keywords: 'nix' })), '`keywords`');
fatal(plugin(minimal({ keywords: ['nix', 1] })), '`keywords`');
fatal(plugin(minimal({ extensions: { 'com.example': 1 } })), '`extensions.com.example`');
const escaped = plugin();
symlinkSync(join(plugin(minimal()), 'plugin.json'), join(escaped, 'plugin.json'));
fatal(escaped, 'outside the plugin root');

// §5.2, §8.1: unknown fields and a non-object `extensions` are only reported.
const valid = ok(plugin(minimal({
  skills: './skills', extensions: [], author: { name: 'a' }, keywords: ['k'], version: 'not semver',
})));
assert.deepEqual(valid.manifest, minimal({ author: { name: 'a' }, keywords: ['k'], version: 'not semver' }));
assert.ok(valid.reports.some((r: string) => r.includes('`skills`')), valid.reports);
assert.ok(valid.reports.some((r: string) => r.includes('`extensions`')), valid.reports);
assert.ok(ok(plugin(minimal({ name: 'acme.tools', extensions: { 'com.example': { x: [1] } } }))).manifest.extensions);

// §6.2: absent locations are not errors; the wrong kind disables one type.
const empty = ok(plugin(minimal()));
assert.deepEqual([empty.skills, empty.mcpServers, empty.reports], [{}, {}, []]);
const wrong = ok(plugin(minimal(), { skills: 'a file', 'mcp.json/x': 'a directory' }));
assert.deepEqual([wrong.skills, wrong.mcpServers, wrong.reports.length], [{}, {}, 2]);
const outside = plugin(minimal(), { 'mcp.json': { $schema: MCP, mcpServers: { s: { type: 'stdio', command: 'x' } } } });
symlinkSync(plugin(undefined, { 's/SKILL.md': 'x' }), join(outside, 'skills'));
const split = ok(outside);
assert.deepEqual([split.skills, Object.keys(split.mcpServers)], [{}, ['s']]);

// §7.1: immediate children with a regular SKILL.md; in-root links are kept,
// escaping ones skipped.
const skills = plugin(minimal(), {
  'skills/a/SKILL.md': 'a', 'skills/a/scripts/run.sh': 'run',
  'skills/lower/skill.md': 'not exact', 'skills/nested/deeper/SKILL.md': 'too deep',
  'skills/dir-md/SKILL.md/x': 'a directory', 'shared/notes.md': 'shared',
  'skills/c/SKILL.md': 'c',
});
const elsewhere = plugin(undefined, { 'SKILL.md': 'outside', secret: 'outside' });
symlinkSync('../../shared/notes.md', join(skills, 'skills/a/notes.md'));
symlinkSync(join(elsewhere, 'secret'), join(skills, 'skills/a/secret'));
symlinkSync('.', join(skills, 'skills/a/loop'));
symlinkSync('missing', join(skills, 'skills/a/dangling'));
mkdirSync(join(skills, 'skills/b'));
symlinkSync(join(elsewhere, 'SKILL.md'), join(skills, 'skills/b/SKILL.md'));
symlinkSync('../shared', join(skills, 'skills/linked'));
symlinkSync('c', join(skills, 'skills/linked-skill'));
mkdirSync(join(skills, 'skills/__proto__'));
writeFileSync(join(skills, 'skills/__proto__/SKILL.md'), 'x');
const found = ok(skills);
assert.deepEqual(found.skills, {
  a: ['SKILL.md', 'notes.md', 'scripts/run.sh'],
  c: ['SKILL.md'],
  'linked-skill': ['SKILL.md'],
});
for (const label of ['skills/a/secret', 'skills/a/loop', 'skills/a/dangling', 'skills/b', 'skills/__proto__']) {
  assert.ok(found.reports.some((r: string) => r.startsWith(label + ':')), label);
}

// §7.2.2: top-level problems disable MCP for the plugin only.
for (const config of ['{', [], { $schema: MCP }, { mcpServers: {} },
  { $schema: MCP.replace('1.0.0', '9.0.0'), mcpServers: {} },
  { $schema: MCP, mcpServers: [] },
  { $schema: MCP, mcpServers: {}, extra: 1 }]) {
  const disabled = ok(plugin(minimal(), { 'mcp.json': config, 'skills/a/SKILL.md': 'a' }));
  assert.deepEqual([disabled.mcpServers, Object.keys(disabled.skills)], [{}, ['a']], JSON.stringify(config));
  assert.ok(disabled.reports.some((r: string) => r.includes('MCP disabled')), disabled.reports);
}
assert.deepEqual(servers({}).mcpServers, {});

// §10.1: a recognized but different version disables MCP. Only 1.0.0 exists,
// so teach an in-process reader a second one.
const module = await import(reader);
module.MCP_SCHEMAS['https://agent-plugins.org/schemas/1.1.0/mcp.schema.json'] = '1.1.0';
const mismatch = plugin(minimal(), {
  'mcp.json': {
    $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json',
    mcpServers: { s: { type: 'stdio', command: 'x' } },
  },
});
let stdout = '';
let stderr = '';
const writes = [process.stdout.write, process.stderr.write];
process.stdout.write = ((chunk: string) => (stdout += chunk, true)) as typeof process.stdout.write;
process.stderr.write = ((chunk: string) => (stderr += chunk, true)) as typeof process.stderr.write;
try {
  assert.equal(module.main(mismatch), 0);
} finally {
  [process.stdout.write, process.stderr.write] = writes;
}
assert.deepEqual(JSON.parse(stdout).mcpServers, {});
assert.ok(stderr.includes('plugin.json targets 1.0.0'), stderr);

// §7.2.1, §9.2: each invalid entry is skipped alone.
const invalid: Record<string, unknown> = {
  'no-type': { command: 'x' },
  'bad-type': { type: 'http', url: 'https://example.com' },
  'no-command': { type: 'stdio' },
  'empty-command': { type: 'stdio', command: '' },
  'parent-command': { type: 'stdio', command: '../x' },
  'absolute-command': { type: 'stdio', command: '/bin/sh' },
  'relative-command': { type: 'stdio', command: 'bin/x' },
  'foreign-field': { type: 'stdio', command: 'x', url: 'https://example.com' },
  args: { type: 'stdio', command: 'x', args: 'a' },
  'arg-type': { type: 'stdio', command: 'x', args: [1] },
  nul: { type: 'stdio', command: 'x', args: ['a\0b'] },
  env: { type: 'stdio', command: 'x', env: [] },
  'env-value': { type: 'stdio', command: 'x', env: { A: 1 } },
  'env-root': { type: 'stdio', command: 'x', env: { PLUGIN_ROOT: '/' } },
  'env-data': { type: 'stdio', command: 'x', env: { PLUGIN_DATA: '/' } },
  'env-equals': { type: 'stdio', command: 'x', env: { 'A=B': 'c' } },
  'cwd-bare': { type: 'stdio', command: 'x', cwd: 'data' },
  'cwd-absolute': { type: 'stdio', command: 'x', cwd: '/tmp' },
  'cwd-parent': { type: 'stdio', command: 'x', cwd: './../..' },
  'cwd-root-parent': { type: 'stdio', command: 'x', cwd: '${PLUGIN_ROOT}/..' },
  'cwd-prefix': { type: 'stdio', command: 'x', cwd: '${PLUGIN_ROOT}x' },
  'cwd-link': { type: 'stdio', command: 'x', cwd: './out' },
  'command-link': { type: 'stdio', command: './out/x' },
  // `out/..` is the parent of out's target, outside the root, not the root.
  'command-link-parent': { type: 'stdio', command: './out/../x' },
  'cwd-link-parent': { type: 'stdio', command: 'x', cwd: './out/..' },
  'cwd-root-link-parent': { type: 'stdio', command: 'x', cwd: '${PLUGIN_ROOT}/out/..' },
  'no-url': { type: 'streamable-http' },
  'stdio-field': { type: 'sse', url: 'https://example.com', command: 'x' },
  'plain-http': { type: 'streamable-http', url: 'http://example.com/mcp' },
  'plain-http-lookalike': { type: 'streamable-http', url: 'http://localhost.example.com/mcp' },
  'relative-url': { type: 'streamable-http', url: '/mcp' },
  ftp: { type: 'streamable-http', url: 'ftp://example.com/mcp' },
  userinfo: { type: 'streamable-http', url: 'https://user:pw@example.com/mcp' },
  fragment: { type: 'streamable-http', url: 'https://example.com/mcp#x' },
  'bad-port': { type: 'streamable-http', url: 'https://example.com:99999/mcp' },
  'space-url': { type: 'streamable-http', url: 'https://example.com/a b' },
  headers: { type: 'streamable-http', url: 'https://example.com', headers: [] },
  'header-name': { type: 'streamable-http', url: 'https://example.com', headers: { 'X Y': 'z' } },
  'header-value': { type: 'streamable-http', url: 'https://example.com', headers: { X: 'a\r\nB: c' } },
  'header-space': { type: 'streamable-http', url: 'https://example.com', headers: { X: ' padded' } },
  'header-case': { type: 'sse', url: 'https://example.com', headers: { 'X-A': '1', 'x-a': '2' } },
  'not-object': 'stdio',
};
const validServers: Record<string, Record<string, unknown>> = {
  bare: { type: 'stdio', command: 'npx', args: ['${PLUGIN_ROOT}/a'], env: { 'A-B': '${HOME}' } },
  relative: { type: 'stdio', command: './bin/server', cwd: './bin' },
  'root-cwd': { type: 'stdio', command: 'x', cwd: '${PLUGIN_ROOT}' },
  'data-cwd': { type: 'stdio', command: 'x', cwd: '${PLUGIN_DATA}/sub/../..' },
  localhost: { type: 'streamable-http', url: 'http://localhost:8080/mcp' },
  loopback: { type: 'sse', url: 'http://127.0.0.2/sse' },
  loopback6: { type: 'streamable-http', url: 'http://[::1]:1/mcp' },
  remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Tenant': 'a b' } },
};
// JSON.parse keeps `__proto__` as a key, as an mcp.json would.
const mcpJson = JSON.stringify({ $schema: MCP, mcpServers: { ...invalid, ...validServers } })
  .replace('"mcpServers":{', '"mcpServers":{"__proto__":{"type":"stdio","command":"x"},');
const root = plugin(minimal(), { 'bin/server': '', 'mcp.json': mcpJson });
symlinkSync(work, join(root, 'out'));
const loaded = ok(root);
assert.deepEqual(new Set(Object.keys(loaded.mcpServers)), new Set(Object.keys(validServers)));
for (const name of [...Object.keys(invalid), '__proto__']) {
  assert.ok(loaded.reports.some((r: string) => r.startsWith(`mcp.json: server "${name}" skipped`)), name);
}
assert.deepEqual(loaded.mcpServers.bare, validServers.bare);
assert.deepEqual(loaded.mcpServers.relative, { ...validServers.relative, args: [], env: {}, cwdBase: 'root' });
// PLUGIN_DATA containment is only known at launch; the launcher checks it.
assert.equal(loaded.mcpServers['data-cwd'].cwdBase, 'data');
assert.deepEqual(loaded.mcpServers.remote.headers, { 'X-Tenant': 'a b' });

console.log('read-plugin: all checks passed');
