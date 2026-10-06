/**
 * Codex's AGENT_DISTRO_PLUGINS installs, against a stand-in `codex` that does
 * what `plugin add` does to its home: no VM, no Codex.
 *
 * Usage: node check-adapter.ts SRC HARNESS_DIR
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { ensureInstalled } = await import(join(process.argv[2], 'harness/codex.ts'));
const temporary = () => mkdtempSync(join(tmpdir(), 'codex-adapter-'));
const DAY = 24 * 60 * 60 * 1000;

/**
 * A `codex plugin add NAME@MARKETPLACE` stand-in. It records what its home held
 * when it started, then writes the plugin as Codex does; FAKE_CODEX=partial
 * stops halfway and fails, as a killed install would.
 */
const fake = join(temporary(), 'codex');
writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CODEX_HOME;
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(fs.readdirSync(home)));
const [name, marketplace] = process.argv[process.argv.length - 1].split('@');
const root = path.join(home, 'plugins/cache', marketplace, name, '1.0.0');
fs.mkdirSync(root, { recursive: true });
if (process.env.FAKE_CODEX === 'partial') process.exit(1);
if (process.env.FAKE_RACE) {
  const first = path.join(process.env.FAKE_RACE, 'plugins/cache', marketplace, name, '1.0.0');
  fs.mkdirSync(first, { recursive: true });
  fs.writeFileSync(path.join(first, 'plugin.json'), '{"first": true}');
}
fs.writeFileSync(path.join(root, 'plugin.json'), '{}');
`);
chmodSync(fake, 0o755);

function install(home: string, marketplace = 'agent-distro-0000000000000000', mode = '') {
  process.env.FAKE_CODEX = mode;
  process.env.FAKE_LOG = join(home, '..', 'started-with.json');
  try {
    ensureInstalled(home, fake, `marketplaces.${marketplace}={}`, marketplace, 'example');
  } finally {
    delete process.env.FAKE_CODEX;
  }
}

test('an interrupted install is never taken for a finished one', () => {
  const home = join(temporary(), 'codex-home');
  mkdirSync(home);
  assert.throws(() => install(home, undefined, 'partial'), /cannot install example@agent-distro-0000000000000000/);
  assert.ok(!existsSync(join(home, 'plugins/cache/agent-distro-0000000000000000')));
  assert.deepEqual(readdirSync(home).filter((name) => name.startsWith('.agent-distro-install-')), []);
  install(home);
  assert.ok(existsSync(join(home, 'plugins/cache/agent-distro-0000000000000000/example/1.0.0/plugin.json')));
});

test('the installer starts from an empty home, never the user\'s', () => {
  const home = join(temporary(), 'codex-home');
  mkdirSync(home);
  writeFileSync(join(home, 'auth.json'), '{"secret": true}');
  writeFileSync(join(home, 'config.toml'), 'model = "mine"\n');
  install(home);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '..', 'started-with.json'), 'utf8')), []);
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), 'model = "mine"\n');
});

test('an install already there is used, and stamped', () => {
  const home = join(temporary(), 'codex-home');
  mkdirSync(home);
  install(home);
  const installed = join(home, 'plugins/cache/agent-distro-0000000000000000');
  const old = new Date(Date.now() - 30 * DAY);
  utimesSync(installed, old, old);
  writeFileSync(join(home, '..', 'started-with.json'), 'not run');
  install(home);
  assert.equal(readFileSync(join(home, '..', 'started-with.json'), 'utf8'), 'not run');
  assert.ok(Date.now() - statSync(installed).mtimeMs < DAY);
});

test('a concurrent install that finished first is kept', () => {
  const home = join(temporary(), 'codex-home');
  mkdirSync(home);
  // Another launch renames its install in while this one's installer runs.
  process.env.FAKE_RACE = home;
  try {
    install(home);
  } finally {
    delete process.env.FAKE_RACE;
  }
  const kept = join(home, 'plugins/cache/agent-distro-0000000000000000/example/1.0.0/plugin.json');
  assert.equal(readFileSync(kept, 'utf8'), '{"first": true}');
  assert.deepEqual(readdirSync(home).filter((name) => name.startsWith('.agent-distro-install-')), []);
});

test('an install removes unused ones and abandoned scratch homes, nothing else', () => {
  const home = join(temporary(), 'codex-home');
  const cache = join(home, 'plugins/cache');
  const old = new Date(Date.now() - 30 * DAY);
  for (const name of ['agent-distro-aaaaaaaaaaaaaaaa', 'agent-distro-bbbbbbbbbbbbbbbb', 'someone-else']) {
    mkdirSync(join(cache, name), { recursive: true });
  }
  utimesSync(join(cache, 'agent-distro-aaaaaaaaaaaaaaaa'), old, old);
  utimesSync(join(cache, 'someone-else'), old, old);
  mkdirSync(join(home, '.agent-distro-install-old'));
  utimesSync(join(home, '.agent-distro-install-old'), old, old);
  mkdirSync(join(home, '.agent-distro-install-new'));
  install(home);
  assert.deepEqual(readdirSync(cache).sort(), ['agent-distro-0000000000000000', 'agent-distro-bbbbbbbbbbbbbbbb', 'someone-else']);
  assert.deepEqual(readdirSync(home).filter((name) => name.startsWith('.agent-distro-install-')), ['.agent-distro-install-new']);
});
