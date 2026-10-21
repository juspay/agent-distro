/**
 * AGENT_DISTRO_PLUGINS without a VM or a harness: cache keys, re-translation,
 * name-based precedence between the profile in effect's plugins and the
 * variable's, the cache's upkeep, the shell a launcher evaluates, the launches
 * it must fail, and one launch through `launch-cli.mjs` with AI_PROFILE set —
 * the argument object only the launcher writes. How the stack composes into
 * that one profile is check-profile.ts's.
 *
 * Usage: node check-launch-plugins.ts SRC STORE_PLUGIN STORE_SUBDIRECTORY_PLUGIN NIX_HASH PROMPT_SECRETS_NIX
 *
 * STORE_PLUGIN is a plugin that is a store path of its own, and
 * STORE_SUBDIRECTORY_PLUGIN one inside a larger store path, as kolu ships it.
 * PROMPT_SECRETS_NIX is lib/prompt-secrets.nix, the shell fragment the
 * launchers with a secret to ask for embed.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const [src, storePlugin, storeSubdirectoryPlugin, nixHash, promptSecrets] = process.argv.slice(2);
const launch = await import(join(src, 'plugin/launch.ts'));
const { adapter: claude } = await import(join(src, 'harness/claude.ts'));
const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const CLI = join(src, 'plugin/launch-cli.mjs');
const DAY = 24 * 60 * 60 * 1000;
// The shell launchers run in; a build has it as SHELL, not on PATH.
const BASH = process.env.SHELL || 'bash';

const temporary = () => mkdtempSync(join(tmpdir(), 'launch-plugins-'));

/** A plugin directory with one skill. */
function plugin(name: string, skill = 'hello', body = 'Hello'): string {
  const root = join(temporary(), name);
  mkdirSync(join(root, 'skills', skill), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ $schema: SCHEMA, name }));
  writeFileSync(join(root, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${body}\n---\n`);
  return root;
}

/** A description a built profile of the stack holds for a plugin root (`Described`). */
function describedPlugin(root: string) {
  const description = join(temporary(), 'description.json');
  writeFileSync(description, JSON.stringify({
    root, version: '1.0.0', manifest: { $schema: SCHEMA, name: JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).name },
    skills: {}, mcpServers: {}, reports: [],
  }));
  return { root, description };
}

const info = { nixpkgs: '/nix/store/x-nixpkgs', system: 'x86_64-linux' };
const claudeArgs = () => ({ harness: 'claude', bash: '/bin/sh', env: '/usr/bin/env', ...info });

function resolve(value: string, cache: string, own: string[] = [], reports: string[] = [], adapter = claude) {
  return launch.resolve('claude', adapter, claudeArgs(), value, { XDG_CACHE_HOME: cache },
    (message: string) => reports.push(message), own);
}

/** The cache root `resolve` uses for an XDG_CACHE_HOME. */
const cacheDir = (cache: string) => join(cache, 'agent-distro');

function argsFile() {
  const args = join(temporary(), 'args.json');
  writeFileSync(args, JSON.stringify(claudeArgs()));
  return args;
}

/** The launch CLI, as a launcher runs it. */
function run(value: string, env: Record<string, string | undefined> = {}) {
  const environment: Record<string, string> = {};
  for (const [name, item] of Object.entries({ PATH: process.env.PATH, XDG_CACHE_HOME: temporary(), AGENT_DISTRO_PLUGINS: value, ...env })) {
    if (item !== undefined) environment[name] = item;
  }
  return spawnSync(process.execPath, [CLI, argsFile()], { encoding: 'utf8', env: environment, timeout: 30_000 });
}

/** What the launcher runs its harness with: `launched` from the shell the CLI prints. */
function launched(stdout: string): string {
  const match = stdout.match(/^launched='((?:[^']|'"'"')*)'$/m);
  assert.ok(match, stdout);
  return match[1].replaceAll(`'"'"'`, "'");
}

/** The one translation directory and link for a key, after any launches. */
function published(cache: string, key: string) {
  const directory = join(cacheDir(cache), 'plugins', key, 'claude');
  const names = readdirSync(directory);
  const links = names.filter((name) => lstatSync(join(directory, name)).isSymbolicLink());
  return { directory, names, links };
}

test('a store path is its own key, without hashing', () => {
  assert.equal(launch.cacheKey(storePlugin), 'store-' + storePlugin.slice('/nix/store/'.length));
  assert.match(launch.cacheKey(storeSubdirectoryPlugin), /^store-[a-z0-9]{32}-[^/]+%2F[^/]+$/);
  // Nothing under the path is read: an absent one keys the same way.
  assert.equal(launch.cacheKey('/nix/store/00000000000000000000000000000000-absent/plugin'),
    'store-00000000000000000000000000000000-absent%2Fplugin');
  const cache = temporary();
  const [translated] = resolve(storeSubdirectoryPlugin, cache).plugins;
  assert.equal(translated.key, launch.cacheKey(storeSubdirectoryPlugin));
  assert.ok(translated.translation.startsWith(join(cacheDir(cache), 'plugins', translated.key, 'claude') + '/'));
});

test('a long store path still makes one file name, distinct per path', () => {
  const name = '00000000000000000000000000000000-' + 'n'.repeat(178);
  const keys = [
    `/nix/store/${name}/agent-plugin/${'d'.repeat(40)}/sub`,
    `/nix/store/${name}/agent-plugin/${'d'.repeat(40)}/other`,
    `/nix/store/00000000000000000000000000000000-x/${'é'.repeat(80)}`,
  ].map(launch.cacheKey);
  for (const key of keys) assert.ok(Buffer.byteLength(key) <= 255, key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys[0].startsWith('store-00000000000000000000000000000000-n') && keys[0].includes('#'), keys[0]);
  // Short paths keep their readable form.
  assert.ok(!launch.cacheKey(storeSubdirectoryPlugin).includes('#'));
});

test('the content hash is the NAR hash nix-hash computes, odd names included', () => {
  const root = plugin('nar');
  writeFileSync(join(root, 'tool'), '#!/bin/sh\n');
  chmodSync(join(root, 'tool'), 0o755);
  mkdirSync(join(root, 'empty'));
  symlinkSync('skills/hello', join(root, 'link'));
  symlinkSync('/absent/target', join(root, 'dangling'));
  writeFileSync(join(root, 'space and "quote"'), '');
  // A file name that is not UTF-8.
  writeFileSync(Buffer.concat([Buffer.from(root + '/caf'), Buffer.from([0xe9])]), 'latin-1');
  const expected = spawnSync(nixHash, ['--type', 'sha256', '--base16', root], { encoding: 'utf8' });
  assert.equal(expected.status, 0, expected.stderr);
  assert.equal(launch.narHash(root), expected.stdout.trim());
  assert.match(launch.cacheKey(root), /^sha256-[0-9a-f]{64}$/);
});

test('a top-level .git is not part of the key', () => {
  const root = plugin('git');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const key = launch.cacheKey(root);
  writeFileSync(join(root, '.git', 'FETCH_HEAD'), 'fetched');
  assert.equal(launch.cacheKey(root), key);
  writeFileSync(join(root, 'skills/hello/SKILL.md'), 'changed');
  assert.notEqual(launch.cacheKey(root), key);
});

test('a socket or FIFO is left out of the hash, and the plugin still launches', async () => {
  const root = plugin('sock');
  const before = launch.narHash(root);
  // A live socket, as odu keeps `.ci/odu.sock` in the checkout it runs from.
  const server = createServer();
  await new Promise<void>((done) => server.listen(join(root, 's.sock'), done));
  try {
    assert.equal(launch.narHash(root), before);
    const made = spawnSync('mkfifo', [join(root, 'pipe')]);
    assert.equal(made.status, 0, String(made.stderr));
    assert.equal(launch.narHash(root), before);
    assert.equal(resolve(root, temporary()).plugins[0].name, 'sock');
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    server.close();
  }
});

test('a checkout is keyed by content and path, and translated again after an edit', () => {
  const cache = temporary();
  const root = plugin('checkout', 'hello', 'Before');
  const first = resolve(root, cache).plugins[0];
  assert.match(first.key, /^sha256-[0-9a-f]{64}$/);
  const skill = join(first.translation, 'skills/hello/SKILL.md');
  assert.match(readFileSync(skill, 'utf8'), /Before/);
  assert.equal(resolve(root, cache).plugins[0].translation, first.translation);
  writeFileSync(join(root, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: After\n---\n');
  const second = resolve(root, cache).plugins[0];
  assert.notEqual(second.key, first.key);
  assert.match(readFileSync(join(second.translation, 'skills/hello/SKILL.md'), 'utf8'), /After/);
  assert.match(readFileSync(skill, 'utf8'), /Before/, 'a translation in use is never rewritten');
  const copy = join(temporary(), 'checkout');
  cpSync(root, copy, { recursive: true });
  assert.notEqual(resolve(copy, cache).plugins[0].key, second.key);
});

test('relative, trailing-slash and symlinked entries resolve to their directory', () => {
  const cache = temporary();
  const root = plugin('spelled');
  const key = launch.cacheKey(root);
  const link = join(temporary(), 'link');
  symlinkSync(root, link);
  const intoStore = join(temporary(), 'store-link');
  symlinkSync(storeSubdirectoryPlugin, intoStore);
  const here = process.cwd();
  try {
    process.chdir(join(root, '..'));
    for (const entry of ['spelled', './spelled/', root + '/', link]) {
      assert.equal(resolve(entry, cache).plugins[0].key, key, entry);
    }
  } finally {
    process.chdir(here);
  }
  assert.equal(resolve(intoStore, cache).plugins[0].key, launch.cacheKey(storeSubdirectoryPlugin));
});

test('a translation is replaced only by name, and the variable wins', () => {
  const cache = temporary();
  // The profile in effect's own plugin directories, which lead the variable's.
  const own = [plugin('kolu'), plugin('skills')];
  const early = plugin('kolu', 'early');
  const late = plugin('kolu', 'late');
  const extra = plugin('extra');
  const result = resolve([early, extra, late].join(':'), cache, own);
  assert.deepEqual(result.plugins.map((p: any) => [p.name, p.description.root]),
    [['skills', own[1]], ['extra', extra], ['kolu', late]]);
  const words = claude.launch(result);
  // Every directory the harness is handed is a translation, the profile's too.
  assert.equal(words, result.plugins.map((p: any) => `--plugin-dir ${p.translation}`).join(' '));
  assert.ok(!words.includes(own[0]), 'the replaced profile plugin is gone');
  // A name matches whatever the versions are.
  const versioned = plugin('skills');
  writeFileSync(join(versioned, 'plugin.json'), JSON.stringify({ $schema: SCHEMA, name: 'skills', version: '0.0.1' }));
  assert.deepEqual(resolve(versioned, cache, own).plugins.map((p: any) => p.description.root), [own[0], versioned]);
});

test('no entries load nothing and need no cache', () => {
  assert.deepEqual(launch.entries(''), []);
  assert.deepEqual(launch.entries('::a::b:'), ['a', 'b']);
  const result = run(':', { XDG_CACHE_HOME: undefined, HOME: undefined });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(launched(result.stdout), '');
});

test("a profile's plugins lead the variable's, which still wins by name", () => {
  const cache = temporary();
  const own = plugin('own');
  const extra = plugin('extra');
  assert.deepEqual(resolve(extra, cache, [own]).plugins.map((p: any) => p.name), ['own', 'extra']);
  const same = plugin('own', 'other');
  assert.equal(resolve(same, cache, [own]).plugins[0].description.root, same);
  // A launch with anything to translate and nowhere to cache starts without
  // them, saying so on stderr, rather than not starting at all.
  const homeless = (value: string, roots: string[]) =>
    launch.resolve('claude', claude, claudeArgs(), value, {}, () => {}, roots);
  assert.deepEqual(homeless('', [own]).plugins, []);
  assert.deepEqual(homeless(extra, []).plugins, []);
});

test('a description a built profile holds is used instead of reading the root', () => {
  const root = plugin('held');
  const held = describedPlugin(root);
  // Only the description names it this, so a re-read of the root cannot.
  const description = JSON.parse(readFileSync(held.description, 'utf8'));
  description.manifest.name = 'from-the-description';
  writeFileSync(held.description, JSON.stringify(description));
  const result = launch.resolve('claude', claude, claudeArgs(), '', { XDG_CACHE_HOME: temporary() },
    () => {}, [root], [held]);
  assert.deepEqual(result.plugins.map((p: any) => p.name), ['from-the-description']);
});

test("a profile's plugin that is not a directory fails naming the profile", () => {
  const missing = join(temporary(), 'missing');
  assert.throws(() => launch.resolve('claude', claude, claudeArgs(), '', { XDG_CACHE_HOME: temporary() },
    () => {}, [missing], [], 'profile github:o/skills'),
  (error: Error) => error.message === `profile github:o/skills: ${missing} is not a directory`);
});

test('the shell a launcher evaluates', () => {
  const env = {
    LITELLM_BASE_URL: 'https://gateway.example',
    OMP_SKIP_SETUP: '1',
    LITELLM_API_KEY: { secret: true, hint: "it's here" },
    SECOND_KEY: { secret: true },
  };
  const text = launch.shell("-e '/a b'", env, { modelRoles: { default: 'litellm/large' } },
    ['/nix/store/x/bin', '/nix/store/y/bin']);
  const output = spawnSync(BASH, ['-euc',
    `PATH=/usr/bin; ${text} printf '%s\\n' "$launched" "\${#profile_env_secrets[@]}" "\${profile_env_secrets[1]}"`
    + ' "\${profile_env_secrets[0]}" "$profile_settings" "$LITELLM_BASE_URL" "$OMP_SKIP_SETUP" "$PATH"'],
  { encoding: 'utf8', env: { AGENT_DISTRO_PROFILE: '{}' } });
  assert.equal(output.status, 0, output.stderr);
  // A secret is named with its hint, so the launcher is handed one array
  // rather than two it must keep in lockstep.
  assert.deepEqual(output.stdout.split('\n').slice(0, 8), [
    "-e '/a b'", '2', 'SECOND_KEY=', "LITELLM_API_KEY=it's here", '{"modelRoles":{"default":"litellm/large"}}',
    'https://gateway.example', '1', '/nix/store/x/bin:/nix/store/y/bin:/usr/bin',
  ]);
  const none = spawnSync(BASH, ['-euc',
    `${launch.shell('', {}, undefined, [])} printf '%s|%s|%s' "\${profile_env_secrets[*]}" "$profile_settings" "\${AGENT_DISTRO_PROFILE-unset}"`],
  { encoding: 'utf8', env: { AGENT_DISTRO_PROFILE: '{}', PATH: process.env.PATH } });
  assert.equal(none.stdout, '||unset', none.stderr);
});

test('a launcher asks for a secret the environment does not set, and refuses without a terminal', () => {
  // The fragment the launchers embed, as nix writes it: its `''${` escaping
  // undone, and the gum it is handed left as the command it names.
  const source = readFileSync(promptSecrets, 'utf8');
  const fragment = source.slice(source.indexOf("''\n") + 3, source.lastIndexOf("''"))
    .replaceAll("''${", '${').replace('${gum}/bin/gum', 'gum');
  const shell = (env: Parameters<typeof launch.shell>[1], tail: string, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(BASH, ['-euc', `${launch.shell('', env, undefined, [])}${fragment}${tail}`],
      { encoding: 'utf8', env: { PATH: process.env.PATH, ...extra } });
  const secret = { LITELLM_API_KEY: { secret: true, hint: 'ask the team' } };
  // Not set, no terminal: the variable and its hint are named, and the launch stops.
  const refused = shell(secret, 'echo reached');
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(refused.stdout, '', 'the harness is never started');
  assert.match(refused.stderr, /^agent-distro: warning: LITELLM_API_KEY is not set\.$/m);
  assert.match(refused.stderr, /^  ask the team$/m);
  assert.match(refused.stderr, /^  Tip: export LITELLM_API_KEY=\.\.\. to skip this prompt next time\.$/m);
  assert.match(refused.stderr, /^agent-distro: error: cannot prompt for LITELLM_API_KEY \(stdin is not a terminal\)\.$/m);
  // Set: nothing is said, and nothing is asked for.
  const quiet = shell(secret, 'echo reached', { LITELLM_API_KEY: 'k' });
  assert.equal(quiet.stdout, 'reached\n', quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /agent-distro/, quiet.stderr);
  // An empty value counts as unset: the launch asks for it.
  const empty = shell(secret, 'echo reached', { LITELLM_API_KEY: '' });
  assert.equal(empty.status, 1, empty.stdout);
  assert.match(empty.stderr, /LITELLM_API_KEY is not set/);
  // A secret with no hint, and a profile with none at all.
  const bare = shell({ LITELLM_API_KEY: { secret: true } }, 'echo reached');
  assert.match(bare.stderr, /^agent-distro: warning: LITELLM_API_KEY is not set\.$\n\n  Tip:/m);
  const none = shell({}, 'echo reached');
  assert.equal(none.stdout, 'reached\n', none.stderr);
  assert.doesNotMatch(none.stderr, /agent-distro/, none.stderr);
});

test('reports reach stderr on every launch, cached or not, without control characters', () => {
  const cache = temporary();
  const root = plugin('reported');
  writeFileSync(join(root, 'mcp.json'), '{');
  for (let i = 0; i < 2; i++) {
    const reports: string[] = [];
    resolve(root, cache, [], reports);
    assert.equal(reports.length, 1, JSON.stringify(reports));
    assert.match(reports[0], /mcp\.json: MCP disabled, it is not valid JSON/);
  }
  // Tab and newline stay: reports are lines of text.
  assert.equal(launch.printable('a\x1b[31mb\x9bc\td\ne\x07'), 'a\\x1b[31mb\\x9bc\td\ne\\x07');
});

test('a corrupt cache names the directory to remove', () => {
  const cache = temporary();
  const root = plugin('corrupt');
  const { key } = resolve(root, cache).plugins[0];
  const { directory, links } = published(cache, key);
  const target = join(directory, readlinkSync(join(directory, links[0])));
  writeFileSync(join(target, 'reports.json'), JSON.stringify(['\x1b]0;title\x07']));
  const escaped = run(root, { XDG_CACHE_HOME: cache });
  assert.equal(escaped.status, 0, escaped.stderr);
  assert.ok(!escaped.stderr.includes('\x1b'), escaped.stderr);
  assert.match(escaped.stderr, /^agent-distro plugin: warning: .*\\x1b\]0;title\\x07/m);
  writeFileSync(join(target, 'description.json'), '{"root": 1}');
  const result = run(root, { XDG_CACHE_HOME: cache });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`^agent-distro plugin: error: AGENT_DISTRO_PLUGINS: the cached .*description\\.json is unreadable or corrupt; remove ${directory} and launch again`));
  writeFileSync(join(target, 'description.json'), '{');
  assert.equal(run(root, { XDG_CACHE_HOME: cache }).status, 1);
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
  assert.equal(result.stderr, `agent-distro plugin: error: AGENT_DISTRO_PLUGINS: ${missing} is not a directory\n`);
  const file = join(temporary(), 'file');
  writeFileSync(file, '');
  assert.match(run(file).stderr, /is not a directory/);
  if (process.getuid?.() !== 0) {
    const locked = temporary();
    const inside = plugin('inside');
    cpSync(inside, join(locked, 'inside'), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      assert.match(run(join(locked, 'inside')).stderr, /EACCES/);
    } finally {
      chmodSync(locked, 0o700);
    }
  }
});

test('the cache directory must be absolute and writable', () => {
  const blocked = join(temporary(), 'blocked');
  writeFileSync(blocked, '');
  const unwritable = run(plugin('uncached'), { XDG_CACHE_HOME: blocked });
  assert.equal(unwritable.status, 1, unwritable.stderr);
  assert.match(unwritable.stderr, /^agent-distro plugin: error: .*ENOTDIR/);
  const homeless = run(plugin('homeless'), { XDG_CACHE_HOME: undefined, HOME: undefined });
  // Nowhere to cache is not an error: the plugins that need translating are
  // skipped, said so, and the launch carries on.
  assert.equal(homeless.status, 0, homeless.stderr);
  assert.match(homeless.stderr, /XDG_CACHE_HOME and HOME are unset; skipping plugins that need translating/);
  const cwd = temporary();
  const relativeCache = spawnSync(process.execPath, [CLI, argsFile()], {
    encoding: 'utf8', cwd, env: { PATH: process.env.PATH, XDG_CACHE_HOME: 'rel', AGENT_DISTRO_PLUGINS: plugin('relative') },
  });
  assert.equal(relativeCache.status, 1, relativeCache.stderr);
  assert.match(relativeCache.stderr, /XDG_CACHE_HOME must be an absolute path, not "rel"/);
  assert.deepEqual(readdirSync(cwd), [], 'nothing is written under the working directory');
  assert.match(run(plugin('home'), { XDG_CACHE_HOME: undefined, HOME: 'home' }).stderr, /HOME must be an absolute path/);
});

test('translate sees only the translation inputs', () => {
  let seen: unknown;
  const adapter = { ...claude, translationInputs: () => ({ only: 'this' }), translate: (_d: unknown, _o: string, inputs: unknown) => { seen = inputs; } };
  resolve(plugin('inputs'), temporary(), [], [], adapter);
  assert.deepEqual(seen, { only: 'this' });
});

test('a checkout that changes while it is translated is translated again', () => {
  const cache = temporary();
  const root = plugin('moving', 'hello', 'Before');
  let edits = 1;
  const adapter = {
    ...claude,
    translate: (description: any, out: string, inputs: any, report: any, key: string) => {
      claude.translate(description, out, inputs, report, key);
      if (edits-- > 0) writeFileSync(join(root, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: After\n---\n');
    },
  };
  const [translated] = resolve(root, cache, [], [], adapter).plugins;
  assert.equal(translated.key, launch.cacheKey(root));
  assert.match(readFileSync(join(translated.translation, 'skills/hello/SKILL.md'), 'utf8'), /After/);
  assert.equal(readdirSync(join(cacheDir(cache), 'plugins')).length, 1, 'the first attempt was never published');
  let counter = 0;
  const restless = { ...claude, translate: () => writeFileSync(join(root, 'counter'), String(counter++)) };
  assert.throws(() => resolve(root, temporary(), [], [], restless), /kept changing while it was translated/);
});

test('a new runtime is a new translator', () => {
  const copy = join(temporary(), 'src');
  cpSync(src, copy, { recursive: true });
  // Its dependencies, beside it as in the runtime tree.
  symlinkSync(join(src, '../node_modules'), join(copy, '../node_modules'));
  return import(join(copy, 'plugin/launch.ts')).then(async (other) => {
    const { adapter: otherClaude } = await import(join(copy, 'harness/claude.ts'));
    const cache = temporary();
    const root = plugin('runtime');
    const first = resolve(root, cache).plugins[0];
    const second = other.resolve('claude', otherClaude, claudeArgs(), root, { XDG_CACHE_HOME: cache }, () => {}).plugins[0];
    assert.equal(first.key, second.key);
    assert.notEqual(first.translation, second.translation);
    assert.equal(published(cache, first.key).links.length, 2);
  });
});

test('concurrent first launches publish one translation, and all use it', async () => {
  const cache = temporary();
  const root = plugin('raced');
  const args = argsFile();
  const outputs = await Promise.all(Array.from({ length: 12 }, () => new Promise<string>((done, fail) => {
    const child = spawn(process.execPath, [CLI, args], {
      env: { PATH: process.env.PATH, XDG_CACHE_HOME: cache, AGENT_DISTRO_PLUGINS: root },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => (code === 0 ? done(stdout) : fail(new Error(stderr))));
  })));
  assert.equal(new Set(outputs).size, 1, outputs.join('\n'));
  const { names, links } = published(cache, launch.cacheKey(root));
  assert.equal(links.length, 1);
  assert.equal(names.length, 2, names.join(' '));
});

test('what no launch has used for a while is removed when something new is translated', () => {
  const cache = temporary();
  const old = new Date(Date.now() - (launch.STALE_DAYS + 1) * DAY);
  const unused = resolve(plugin('unused'), cache).plugins[0];
  const used = resolve(plugin('used'), cache).plugins[0];
  const usedRoot = used.description.root;
  const age = (key: string) => {
    const { directory, links } = published(cache, key);
    lutimesSync(join(directory, links[0]), old, old);
  };
  age(unused.key);
  age(used.key);
  resolve(usedRoot, cache);
  // An interrupted launch's directory, old and recent.
  const orphans = join(cacheDir(cache), 'plugins', used.key, 'claude');
  mkdirSync(join(orphans, 'abandoned.000000000000'));
  utimesSync(join(orphans, 'abandoned.000000000000'), old, old);
  mkdirSync(join(orphans, 'inflight.000000000000'));
  resolve(plugin('new'), cache);
  assert.ok(!existsSync(join(cacheDir(cache), 'plugins', unused.key)), 'a stale key is removed whole');
  const { names } = published(cache, used.key);
  assert.ok(names.includes('inflight.000000000000'));
  assert.ok(!names.includes('abandoned.000000000000'));
  assert.equal(names.length, 3, names.join(' '));
  assert.ok(existsSync(join(used.translation, 'skills/hello/SKILL.md')), 'a translation in use stays');
});

test('launch files are reused, and old ones removed when a new one is written', () => {
  const directory = temporary();
  const first = launch.writeAddressed(directory, { a: 1 });
  const old = new Date(Date.now() - (launch.STALE_DAYS + 1) * DAY);
  utimesSync(first, old, old);
  assert.equal(launch.writeAddressed(directory, { a: 1 }), first);
  assert.ok(Date.now() - lstatSync(first).mtimeMs < DAY, 'reuse stamps it');
  utimesSync(first, old, old);
  const second = launch.writeAddressed(directory, { b: 2 });
  assert.deepEqual(readdirSync(directory), [relative(directory, second)]);
});

test('the CLI resolves AI_PROFILE itself, as a direct launch does', () => {
  // A launch runs `launch-cli.mjs`, not the library inside this process: the
  // launcher passes one flat argument object, and nothing here type-checks it
  // (`claudeArgs` above is that object for the in-process cases). A profile
  // directory, resolved through the CLI, is what Home Manager's commands and
  // a direct `AI_PROFILE=… omp` both do.
  const root = temporary();
  const profileDir = join(root, 'smoke');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'smoke', description: 'read at launch',
    extensions: { 'asia.nixos.agent-distro': { env: { SMOKE_MARK: 'here' } } },
  }));

  const result = run('', { AI_PROFILE: profileDir });
  assert.equal(result.status, 0, result.stderr);
  // The profile reached the shell the launcher evaluates: its `env` is
  // exported there, and the launch names it on stderr.
  assert.match(result.stdout, /^export SMOKE_MARK='here'$/m, result.stdout);
  assert.match(result.stderr, /using smoke \(from AI_PROFILE=/, result.stderr);
});
