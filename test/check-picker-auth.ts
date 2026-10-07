/**
 * The picker's auth probes without a VM or a real home: every harness's file
 * and environment route, relocation variables, `AI_GATEWAY=0`, missing, empty,
 * corrupt and unreadable sources. File reads go through a fixture `Io`.
 *
 * Usage: node check-picker-auth.ts SRC
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
// Erased at run time; the module itself comes from SRC.
import type { Io, Spec, Status } from '../src/picker/auth.ts';

const src = process.argv[2];
// The module's path is the SRC argument, so it cannot be a static import.
const { probe, NOT_SIGNED_IN } = await import(join(src, 'picker/auth.ts'));

const files = new Map<string, string>();
const databases = new Map<string, string[]>();
const unreadable = new Set<string>();
const tableless = new Set<string>();
const io: Io = {
  read: (path) => {
    if (unreadable.has(path)) throw new Error(`EACCES: ${path}`);
    return files.get(path);
  },
  sqlite: (path) => {
    if (unreadable.has(path)) throw new Error(`EACCES: ${path}`);
    // A database OMP has not written a credential to yet.
    if (tableless.has(path)) throw new Error('no such table: auth_credentials');
    return databases.get(path)?.map((provider) => ({ provider }));
  },
};

/** A fresh fixture per case: files, sqlite stores, unreadable and tableless paths. */
function reset() {
  files.clear();
  databases.clear();
  unreadable.clear();
  tableless.clear();
}

const home = (values: Record<string, string> = {}) => ({ HOME: '/home/u', ...values });
const read = (spec: Spec, env: Record<string, string | undefined> = home()) => probe(spec, env, io);
const signed = (...items: string[]): Status => ({ text: items.join(', '), items });
const out: Status = { text: NOT_SIGNED_IN, items: [] };

// Claude Code: the email in ~/.claude.json, or an env variable.
reset();
files.set('/home/u/.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }));
assert.deepEqual(read({ scheme: 'anthropic' }), signed('me@example.com'));
// CLAUDE_CONFIG_DIR relocates the file.
reset();
files.set('/cfg/.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'cfg@example.com' } }));
assert.deepEqual(read({ scheme: 'anthropic' }, home({ CLAUDE_CONFIG_DIR: '/cfg' })), signed('cfg@example.com'));
// The environment route, in the harness's own order.
reset();
assert.deepEqual(read({ scheme: 'anthropic' }, home({ ANTHROPIC_API_KEY: 'sk-ant' })), signed('ANTHROPIC_API_KEY'));
assert.deepEqual(read({ scheme: 'anthropic' }, home({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' })), signed('CLAUDE_CODE_OAUTH_TOKEN'));
// A file without an account, no env: not signed in. An empty value does not count.
reset();
files.set('/home/u/.claude.json', JSON.stringify({ oauthAccount: {} }));
assert.deepEqual(read({ scheme: 'anthropic' }), out);
assert.deepEqual(read({ scheme: 'anthropic' }, home({ ANTHROPIC_API_KEY: '' })), out);
// Corrupt or unreadable: unknown (blank).
reset();
files.set('/home/u/.claude.json', '{ not json');
assert.equal(read({ scheme: 'anthropic' }), undefined);
reset();
unreadable.add('/home/u/.claude.json');
assert.equal(read({ scheme: 'anthropic' }), undefined);

// Codex: a `tokens` object, an API key in the file, or the environment.
reset();
files.set('/home/u/.codex/auth.json', JSON.stringify({ tokens: { access_token: 'x' }, OPENAI_API_KEY: null }));
assert.deepEqual(read({ scheme: 'openai' }), signed('ChatGPT'));
reset();
files.set('/home/u/.codex/auth.json', JSON.stringify({ tokens: null, OPENAI_API_KEY: 'sk-openai' }));
assert.deepEqual(read({ scheme: 'openai' }), signed('OPENAI_API_KEY'));
// CODEX_HOME relocates the file.
reset();
files.set('/codex/auth.json', JSON.stringify({ tokens: { access_token: 'x' } }));
assert.deepEqual(read({ scheme: 'openai' }, home({ CODEX_HOME: '/codex' })), signed('ChatGPT'));
// The environment route, and nothing at all.
reset();
assert.deepEqual(read({ scheme: 'openai' }, home({ OPENAI_API_KEY: 'sk' })), signed('OPENAI_API_KEY'));
assert.deepEqual(read({ scheme: 'openai' }), out);
reset();
files.set('/home/u/.codex/auth.json', 'nonsense');
assert.equal(read({ scheme: 'openai' }), undefined);

// A gateway profile: the key and the harness's own providers are usable at
// once, so the status lists the key first and then the providers, sorted.
reset();
const gateway: Spec = { scheme: 'gateway', keyEnv: 'LITELLM_API_KEY', provider: 'omp' };
databases.set('/home/u/.omp/agent/agent.db', ['openai', 'anthropic']);
assert.deepEqual(read(gateway, home({ LITELLM_API_KEY: 'k' })), signed('LITELLM_API_KEY', 'anthropic', 'openai'));
// The panel lists the items one per line, so the key comes first, alone.
assert.deepEqual(read(gateway, home({ LITELLM_API_KEY: 'k' }))!.items, ['LITELLM_API_KEY', 'anthropic', 'openai']);
// The key alone, with nothing in the store or the environment.
reset();
assert.deepEqual(read(gateway, home({ LITELLM_API_KEY: 'k' })), signed('LITELLM_API_KEY'));
// Providers alone, with the key unset; the environment's providers count too.
reset();
databases.set('/home/u/.omp/agent/agent.db', ['openai']);
assert.deepEqual(read(gateway, home({ GEMINI_API_KEY: 'k' })), signed('google', 'openai'));
// Nothing anywhere is "not signed in"; an empty key does not count.
reset();
assert.deepEqual(read(gateway), out);
assert.deepEqual(read(gateway, home({ LITELLM_API_KEY: '' })), out);
// An unreadable store still leaves the key; without the key it is unknown.
reset();
unreadable.add('/home/u/.omp/agent/agent.db');
assert.deepEqual(read(gateway, home({ LITELLM_API_KEY: 'k' })), signed('LITELLM_API_KEY'));
assert.equal(read(gateway), undefined);
// AI_GATEWAY=0 is the harness's own providers alone; the key is ignored.
reset();
databases.set('/home/u/.omp/agent/agent.db', ['openai', 'anthropic']);
assert.deepEqual(read(gateway, home({ AI_GATEWAY: '0', LITELLM_API_KEY: 'k' })), signed('anthropic', 'openai'));
reset();
assert.deepEqual(read(gateway, home({ AI_GATEWAY: '0', LITELLM_API_KEY: 'k' })), out);

// OMP's providers come from the SQLite store, relocated by PI_CODING_AGENT_DIR
// or XDG_DATA_HOME.
reset();
databases.set('/home/u/.omp/agent/agent.db', ['openai', 'anthropic']);
assert.deepEqual(read({ scheme: 'provider', provider: 'omp' }), signed('anthropic', 'openai'));
reset();
databases.set('/agent/agent.db', ['xai']);
assert.deepEqual(read({ scheme: 'provider', provider: 'omp' }, home({ PI_CODING_AGENT_DIR: '/agent' })), signed('xai'));
reset();
databases.set('/data/omp/agent.db', ['google']);
assert.deepEqual(read({ scheme: 'provider', provider: 'omp' }, home({ XDG_DATA_HOME: '/data' })), signed('google'));
// An empty store, a missing one, and an unreadable one.
reset();
databases.set('/home/u/.omp/agent/agent.db', []);
assert.deepEqual(read({ scheme: 'provider', provider: 'omp' }), out);
assert.deepEqual(read({ scheme: 'provider', provider: 'omp' }, home({ HOME: '/elsewhere' })), out);
reset();
unreadable.add('/home/u/.omp/agent/agent.db');
assert.equal(read({ scheme: 'provider', provider: 'omp' }), undefined);
// A store with no credential table yet is "not signed in", not blank.
reset();
tableless.add('/home/u/.omp/agent/agent.db');
assert.deepEqual(read({ scheme: 'provider', provider: 'omp' }), out);

// Pi and OpenCode: a JSON object of provider id to credential.
reset();
files.set('/home/u/.pi/agent/auth.json', JSON.stringify({ anthropic: { type: 'api_key', key: 'k' }, openai: { type: 'oauth', access: 'a' } }));
assert.deepEqual(read({ scheme: 'provider', provider: 'pi' }), signed('anthropic', 'openai'));
reset();
files.set('/pi/auth.json', JSON.stringify({ xai: { type: 'api_key', key: 'k' } }));
assert.deepEqual(read({ scheme: 'provider', provider: 'pi' }, home({ PI_CODING_AGENT_DIR: '/pi' })), signed('xai'));
reset();
files.set('/data/opencode/auth.json', JSON.stringify({ google: { type: 'api' }, openai: { type: 'wellknown' } }));
assert.deepEqual(read({ scheme: 'provider', provider: 'opencode' }, home({ XDG_DATA_HOME: '/data' })), signed('google', 'openai'));
assert.deepEqual(read({ scheme: 'provider', provider: 'opencode2' }, home({ XDG_DATA_HOME: '/data' })), signed('google', 'openai'));
reset();
files.set('/home/u/.local/share/opencode/auth.json', JSON.stringify({ anthropic: { type: 'api' } }));
assert.deepEqual(read({ scheme: 'provider', provider: 'opencode' }), signed('anthropic'));
// An empty file, an entry that is not a credential, and a corrupt file.
reset();
files.set('/home/u/.pi/agent/auth.json', '{}');
assert.deepEqual(read({ scheme: 'provider', provider: 'pi' }), out);
files.set('/home/u/.pi/agent/auth.json', JSON.stringify({ anthropic: null }));
assert.deepEqual(read({ scheme: 'provider', provider: 'pi' }), out);
files.set('/home/u/.pi/agent/auth.json', 'not json');
assert.equal(read({ scheme: 'provider', provider: 'pi' }), undefined);

// Providers kept only in the environment, merged with the file's, deduped and
// sorted; the environment still counts when the file is unreadable.
reset();
files.set('/home/u/.pi/agent/auth.json', JSON.stringify({ openai: { type: 'api_key' } }));
assert.deepEqual(read({ scheme: 'provider', provider: 'pi' }, home({ ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k' })),
  signed('anthropic', 'google', 'openai'));
reset();
files.set('/home/u/.pi/agent/auth.json', JSON.stringify({ anthropic: { type: 'api_key' } }));
assert.deepEqual(read({ scheme: 'provider', provider: 'pi' }, home({ ANTHROPIC_API_KEY: 'k' })), signed('anthropic'));
reset();
unreadable.add('/home/u/.pi/agent/auth.json');
assert.equal(read({ scheme: 'provider', provider: 'pi' }), undefined);
assert.deepEqual(read({ scheme: 'provider', provider: 'pi' }, home({ XAI_API_KEY: 'k' })), signed('xai'));

// Status text is drawn on the terminal as is: control and format characters
// are replaced and whitespace collapsed, once, for every scheme.
reset();
files.set('/home/u/.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'me\u001b[31m@example.com' } }));
const escaped = read({ scheme: 'anthropic' })!;
assert.deepEqual(escaped, signed('me [31m@example.com'));
assert.doesNotMatch(escaped.text, /[\p{Cc}\p{Cf}]/u);
reset();
files.set('/home/u/.pi/agent/auth.json', JSON.stringify({ 'an\u0000thropic': { type: 'api_key' } }));
const controlled = read({ scheme: 'provider', provider: 'pi' })!;
assert.deepEqual(controlled, signed('an thropic'));
assert.doesNotMatch(controlled.text, /[\p{Cc}\p{Cf}]/u);

// A spec that names no harness, or an unknown scheme, is unknown — never a throw.
reset();
assert.equal(read({ scheme: 'provider' }), undefined);
assert.equal(read({ scheme: 'gateway' }), undefined);
assert.equal(read({ scheme: 'nonesuch' as Spec['scheme'] }), undefined);

console.log('picker auth: all checks passed');
