/**
 * The Antigravity CLI's translation and how its plugins are placed in a home,
 * without the harness: what is written, what the next launch takes back, a
 * user's own entries left alone, a launch killed partway, and launches whose
 * sessions overlap.
 *
 * Usage: node check-adapter.ts SRC HARNESS_DIR
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { after, test } from 'node:test';

// The module's path is the SRC argument, so it cannot be a static import.
const { adapter, settle, locations, Skipped, ENTRIES } = await import(join(process.argv[2], 'harness/agy.ts'));
const { processIdentity } = await import(join(process.argv[2], 'util.ts'));
const { prune, STALE_DAYS } = await import(join(process.argv[2], 'plugin/launch.ts'));

const temporary = () => mkdtempSync(join(tmpdir(), 'agy-adapter-'));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const inputs = { bash: '/bin/sh', env: '/usr/bin/env' };

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

  // Antigravity's own schema, over the manifest's fields.
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
  assert.ok(!reports.some((line) => line.includes('name')), reports.join('\n'));

  // No servers, no mcp_config.json; a name Antigravity's schema does not
  // allow is carried as it is, and said.
  const bare = join(temporary(), 'out');
  const said: string[] = [];
  adapter.translate({ ...description, manifest: { ...description.manifest, name: 'acme.tools' }, mcpServers: {} },
    bare, inputs, (message: string) => said.push(message));
  assert.ok(!existsSync(join(bare, 'mcp_config.json')));
  assert.equal(readJson(join(bare, 'plugin.json')).name, 'acme.tools');
  assert.ok(said.some((line) => line.includes('"acme.tools" is not one Antigravity\'s manifest schema allows')), said.join('\n'));
});

test('the launch prints the plugins it wants, by name', () => {
  assert.equal(adapter.launch({ args: inputs, plugins: [], cache: null, report: () => {} }), '{}');
  assert.deepEqual(JSON.parse(adapter.launch({
    args: inputs, cache: '/c', report: () => {},
    plugins: [{ name: 'a', translation: '/c/plugins/k/agy/t/out' }, { name: 'b', translation: '/c/plugins/j/agy/t/out' }],
  })), { a: '/c/plugins/k/agy/t/out', b: '/c/plugins/j/agy/t/out' });
});

/** A home, the claims beside it, and translations in a cache laid out as src/plugin/launch.ts lays it out. */
function world() {
  const root = temporary();
  const plugins = join(root, 'home/.gemini/config/plugins');
  const claims = join(root, 'state/agent-distro/agy-launches');
  let count = 0;
  const translation = () => {
    const path = join(root, 'cache/agent-distro/plugins', `key${count++}`, 'agy', 'translator.0', 'out');
    mkdirSync(path, { recursive: true });
    return path;
  };
  const reports: string[] = [];
  const launch = (session: Session, wanted: Record<string, string>) =>
    settle(plugins, claims, session, wanted, (message: string) => reports.push(message));
  /** What the plugins directory holds: a link's target, or `dir`. */
  const listed = () => existsSync(plugins) ? Object.fromEntries(readdirSync(plugins).sort().map((name) => {
    const path = join(plugins, name);
    return [name, lstatSync(path).isSymbolicLink() ? readlinkSync(path) : 'dir'];
  })) : {};
  return { root, plugins, claims, translation, launch, listed, reports };
}

type Session = { pid: number; identity: string };
const running: ChildProcess[] = [];
after(() => running.forEach((child) => child.kill()));

/** A session that runs until `end` is called, as a launched agy does. */
function session(): Session & { end: () => Promise<void> } {
  const child = spawn('sleep', ['600'], { stdio: 'ignore' });
  running.push(child);
  const pid = child.pid!;
  return {
    pid, identity: processIdentity(pid)!,
    // Awaited until Node has reaped it, so the pid no longer answers.
    end: async () => {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}
/** A session that has already ended. */
function ended(): Session {
  const child = spawnSync('true');
  return { pid: child.pid!, identity: 'gone' };
}

test('a process is told apart from a later one with its pid', async () => {
  const live = session();
  assert.ok(live.identity);
  assert.equal(processIdentity(live.pid), live.identity);
  await live.end();
  assert.equal(processIdentity(live.pid), null);
});

test('plugins stay until no running launch uses them, and a user\'s own entries are never touched', () => {
  const { plugins, translation, launch, listed, reports } = world();
  const [a, b, c] = [translation(), translation(), translation()];
  mkdirSync(join(plugins, 'mine'), { recursive: true });
  writeFileSync(join(plugins, 'mine/plugin.json'), '{"name":"mine"}');
  symlinkSync('/somewhere/else', join(plugins, 'linked'));

  assert.deepEqual(launch(ended(), { alpha: a, beta: b }), { alpha: a, beta: b });
  assert.deepEqual(listed(), { alpha: a, beta: b, linked: '/somewhere/else', mine: 'dir' });
  // Its session has ended, so the next launch takes back what it does not want.
  launch(ended(), { beta: b, gamma: c });
  assert.deepEqual(listed(), { beta: b, gamma: c, linked: '/somewhere/else', mine: 'dir' });
  // A new translation of the same plugin replaces its entry.
  launch(ended(), { beta: a });
  assert.deepEqual(listed(), { beta: a, linked: '/somewhere/else', mine: 'dir' });
  // A name one of the user's entries holds is skipped, with a word.
  assert.deepEqual(launch(ended(), { mine: a, linked: b }), {});
  assert.deepEqual(listed(), { linked: '/somewhere/else', mine: 'dir' });
  assert.equal(readFileSync(join(plugins, 'mine/plugin.json'), 'utf8'), '{"name":"mine"}');
  assert.ok(reports.some((line) => line.includes('plugin "mine" skipped')), reports.join('\n'));
  assert.ok(reports.some((line) => line.includes('plugin "linked" skipped')), reports.join('\n'));
});

test('a launch killed partway leaves nothing the next takes for the user\'s', () => {
  const { claims, plugins, translation, launch, listed, reports } = world();
  const [old, renewed] = [translation(), translation()];
  // Killed while the plugin's translation changed: the entry is still the old
  // one, and its claim (if any) is a dead process's, saying the new one.
  mkdirSync(plugins, { recursive: true });
  mkdirSync(claims, { recursive: true });
  symlinkSync(old, join(plugins, 'x'));
  const dead = ended();
  writeFileSync(join(claims, `${dead.pid}.json`), JSON.stringify({ ...dead, directory: plugins, links: { x: renewed } }));
  assert.deepEqual(launch(ended(), { x: renewed }), { x: renewed });
  assert.deepEqual(listed(), { x: renewed });
  assert.deepEqual(reports, []);
  assert.ok(!existsSync(join(claims, `${dead.pid}.json`)), 'a dead launch\'s claim is cleared');
  // Killed after placing an entry and before claiming it: still ours, taken back.
  symlinkSync(old, join(plugins, 'y'));
  launch(ended(), {});
  assert.deepEqual(listed(), {});
});

test('overlapping launches take back only what no running launch uses', async () => {
  const { claims, plugins, translation, launch, listed, reports } = world();
  const [x, y, x2] = [translation(), translation(), translation()];
  const first = session();
  const second = session();
  launch(first, { x });
  launch(second, { y });
  assert.deepEqual(listed(), { x, y });
  // A launch that wants neither, while both run, leaves both.
  launch(ended(), {});
  assert.deepEqual(listed(), { x, y });
  // Once the first has ended, its entry goes; the second's stays.
  await first.end();
  launch(ended(), {});
  assert.deepEqual(listed(), { y });
  await second.end();
  launch(ended(), {});
  assert.deepEqual(listed(), {});
  // Nothing was orphaned: the name is free for a new translation.
  assert.deepEqual(launch(ended(), { x: x2 }), { x: x2 });
  assert.deepEqual(reports, []);
  // The ended launches' claims are gone; only the last launch's own remains.
  assert.equal(readdirSync(claims).filter((name) => name.endsWith('.json')).length, 1);
});

test('of two running launches wanting one name, the later uses the entry already there', async () => {
  const { claims, translation, launch, listed, reports } = world();
  const [t1, t2] = [translation(), translation()];
  const first = session();
  const second = session();
  launch(first, { x: t1 });
  assert.deepEqual(launch(second, { x: t2 }), { x: t1 });
  assert.deepEqual(listed(), { x: t1 });
  assert.ok(reports.some((line) => line.includes('plugin "x": another running agy launch placed another translation of it')), reports.join('\n'));
  // The second claims what it uses, so it outlasts the first.
  await first.end();
  launch(ended(), {});
  assert.deepEqual(listed(), { x: t1 });
  assert.deepEqual(readJson(join(claims, `${second.pid}.json`)).links, { x: t1 });
  await second.end();
});

test('a claim that is not a launch\'s, or names a path outside the directory, is removed and ignored', async () => {
  const { claims, plugins, translation, launch, listed } = world();
  const x = translation();
  const live = session();
  mkdirSync(claims, { recursive: true });
  launch(ended(), { x });
  writeFileSync(join(claims, '1.json'), '[]');
  writeFileSync(join(claims, `${live.pid}.json`), JSON.stringify({ ...live, directory: plugins, links: { '../x': x } }));
  launch(ended(), {});
  assert.deepEqual(listed(), {});
  assert.deepEqual(readdirSync(claims).filter((name) => name.endsWith('.json')), []);
  await live.end();
});

test('a claim whose pid now runs another process is an ended launch\'s', async () => {
  const { claims, plugins, translation, launch, listed } = world();
  const x = translation();
  launch(ended(), { x });
  // The pid is alive, but not as the process that claimed it.
  const reused = session();
  writeFileSync(join(claims, `${reused.pid}.json`),
    JSON.stringify({ pid: reused.pid, identity: `not ${reused.identity}`, directory: plugins, links: { x } }));
  launch(ended(), {});
  assert.deepEqual(listed(), {});
  assert.ok(!existsSync(join(claims, `${reused.pid}.json`)));
  await reused.end();
});

test('launches that share a home share its claims, whatever their XDG_STATE_HOME', async () => {
  const root = temporary();
  const home = join(root, 'home');
  const one = locations({ HOME: home, XDG_STATE_HOME: join(root, 'state-one') });
  const two = locations({ HOME: home, XDG_STATE_HOME: join(root, 'state-two') });
  assert.equal(one.plugins, two.plugins);
  const x = join(root, 'cache/agent-distro/plugins/key/agy/translator.0/out');
  mkdirSync(x, { recursive: true });
  const live = session();
  settle(one.plugins, one.claims, live, { x }, () => {});
  // A launch from a shell that moved its XDG directories still sees the
  // running session's claim, and leaves its entry.
  settle(two.plugins, two.claims, ended(), {}, () => {});
  assert.equal(readlinkSync(join(one.plugins, 'x')), x);
  await live.end();
  settle(two.plugins, two.claims, ended(), {}, () => {});
  assert.ok(!existsSync(join(one.plugins, 'x')));
  assert.equal(locations({ XDG_STATE_HOME: join(root, 'state-one') }), null);
});

test('a launch that cannot write its claim places nothing and takes nothing back', async () => {
  const { claims, plugins, translation, launch, listed } = world();
  const [x, y] = [translation(), translation()];
  // An entry of ours nobody claims, which a launch that could claim would take back.
  mkdirSync(plugins, { recursive: true });
  symlinkSync(y, join(plugins, 'y'));
  mkdirSync(claims, { recursive: true });
  chmodSync(claims, 0o500);
  const live = session();
  try {
    assert.throws(() => launch(live, { x }),
      (error: Error) => error instanceof Skipped && /cannot write this launch's claim in .*; nothing placed or taken back/.test(error.message));
  } finally {
    chmodSync(claims, 0o700);
  }
  assert.deepEqual(listed(), { y });
  await live.end();
});

test('a launch that stops while placing has claimed what it placed', async () => {
  const { claims, translation, launch, listed } = world();
  const [a, b] = [translation(), translation()];
  const live = session();
  // Placing `b` fails, as a full disk would make it, after `a` is placed.
  const place = ENTRIES.place;
  ENTRIES.place = (target: string, path: string) => {
    if (path.endsWith('/b')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC', syscall: 'symlink' });
    return place(target, path);
  };
  try {
    assert.throws(() => launch(live, { a, b }),
      (error: Error) => error instanceof Skipped && /cannot change .*; what this launch placed before that is claimed/.test(error.message));
  } finally {
    ENTRIES.place = place;
  }
  assert.deepEqual(listed(), { a });
  assert.equal(readJson(join(claims, `${live.pid}.json`)).links.a, a);
  // So a later launch leaves it while the session runs.
  launch(ended(), {});
  assert.deepEqual(listed(), { a });
  await live.end();
});

test('a home reached through a symlink shares its claims with the home itself', async () => {
  const root = temporary();
  const home = join(root, 'home');
  mkdirSync(home);
  symlinkSync(home, join(root, 'link'));
  const real = locations({ HOME: home });
  const linked = locations({ HOME: join(root, 'link') });
  const x = join(root, 'cache/agent-distro/plugins/key/agy/translator.0/out');
  mkdirSync(x, { recursive: true });
  const live = session();
  settle(real.plugins, real.claims, live, { x }, () => {});
  settle(linked.plugins, linked.claims, ended(), {}, () => {});
  assert.equal(readlinkSync(join(real.plugins, 'x')), x);
  await live.end();
  settle(linked.plugins, linked.claims, ended(), {}, () => {});
  assert.ok(!existsSync(join(real.plugins, 'x')));
});

test('a running session keeps its translations through a prune, however long since a launch used them', async () => {
  const { root, translation, launch } = world();
  const cache = join(root, 'cache/agent-distro');
  const x = translation();
  // The cache's link to the translation, last used longer ago than any prune keeps.
  const link = join(dirname(dirname(x)), 'translator');
  symlinkSync('translator.0', link);
  const old = new Date(Date.now() - (STALE_DAYS + 1) * 24 * 60 * 60 * 1000);
  lutimesSync(link, old, old);
  const live = session();
  launch(live, { x });
  prune(cache);
  assert.ok(existsSync(join(x, '..', 'holds', `${live.pid}.json`)), 'the launch held its translation');
  assert.ok(existsSync(x), 'a prune removed the translation of a running session');
  await live.end();
  prune(cache);
  assert.ok(!existsSync(x), 'once the session has ended, the stale translation goes');
});

test('two running launches claiming different translations under one name each keep the entry', async () => {
  const { plugins, translation, launch, listed } = world();
  const [ta, tb] = [translation(), translation()];
  const first = session();
  const second = session();
  launch(first, { x: ta });
  // The user removes the first launch's entry by hand; the second places its own.
  rmSync(join(plugins, 'x'));
  launch(second, { x: tb });
  assert.deepEqual(listed(), { x: tb });
  // Whichever claim is read last, a launch wanting nothing leaves an entry
  // either running launch claims: the second's as it is, the first's too.
  launch(ended(), {});
  assert.deepEqual(listed(), { x: tb });
  rmSync(join(plugins, 'x'));
  symlinkSync(ta, join(plugins, 'x'));
  launch(ended(), {});
  assert.deepEqual(listed(), { x: ta });
  await first.end();
  await second.end();
  launch(ended(), {});
  assert.deepEqual(listed(), {});
});
