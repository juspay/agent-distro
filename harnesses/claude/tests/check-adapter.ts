/**
 * The settings the Claude launcher asks this module for, without a running
 * harness: how a table of defaults answers the settings files of the user's,
 * what the shipped table settles, and the shell words the launcher evaluates.
 *
 * Usage: node check-adapter.ts SRC HARNESS_DIR
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The module under test is named by argv, as every check-adapter.ts is.
const src = process.argv[2]!;
const { settingsArguments } = await import(join(src, 'harness/claude.ts'));

/** Two defaults, so what one of them answers cannot stand for the other. */
const TABLE = [
  { name: 'first', settings: { alpha: { on: true } }, decidedBy: ['alpha', 'alphaLegacy'] },
  { name: 'second', settings: { beta: 1 }, decidedBy: ['beta'] },
];
const flag = (settings: unknown) => ['--settings', `'${JSON.stringify(settings)}'`];
const temporary = () => mkdtempSync(join(tmpdir(), 'claude-adapter-'));

/** A home and a launch directory, each with a `.claude` to put settings in. */
function places() {
  const home = temporary();
  const cwd = temporary();
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(cwd, '.claude'));
  return { home, cwd };
}

test('every default the user has left absent goes in one flag', () => {
  const { home, cwd } = places();
  const whole = flag({ alpha: { on: true }, beta: 1 });
  assert.deepEqual(settingsArguments({ HOME: home }, cwd, TABLE), whole);
  // Settings that name none of the keys leave the whole table standing.
  writeFileSync(join(home, '.claude/settings.json'), '{"model":"sonnet"}');
  writeFileSync(join(cwd, '.claude/settings.json'), '{"permissions":{"allow":[]}}');
  writeFileSync(join(cwd, '.claude/settings.local.json'), '{}');
  assert.deepEqual(settingsArguments({ HOME: home }, cwd, TABLE), whole);
  // A file Claude Code cannot read decides nothing, there as here.
  writeFileSync(join(home, '.claude/settings.json'), '{"alpha"');
  assert.deepEqual(settingsArguments({ HOME: home }, cwd, TABLE), whole);
  // Neither a home nor a working directory: nothing of the user's to read.
  assert.deepEqual(settingsArguments({}, undefined, TABLE), whole);
});

test('a default the user has decided stands down, and only that one', () => {
  for (const [file, key] of [
    ['.claude/settings.json', 'alpha'],
    ['.claude/settings.local.json', 'alpha'],
    ['.claude/settings.json', 'alphaLegacy'],
  ]) {
    const { home, cwd } = places();
    writeFileSync(join(cwd, file), `{"${key}":"theirs"}`);
    assert.deepEqual(settingsArguments({ HOME: home }, cwd, TABLE), flag({ beta: 1 }), `${file}: ${key}`);
  }
  // The user's own settings file counts the same as the launch directory's.
  const { home, cwd } = places();
  writeFileSync(join(home, '.claude/settings.json'), '{"beta":0}');
  assert.deepEqual(settingsArguments({ HOME: home }, cwd, TABLE), flag({ alpha: { on: true } }));
  // Every default decided is no flag at all, rather than an empty one.
  writeFileSync(join(cwd, '.claude/settings.json'), '{"alpha":"theirs"}');
  assert.deepEqual(settingsArguments({ HOME: home }, cwd, TABLE), []);
  // CLAUDE_CONFIG_DIR is where Claude Code keeps the user's settings when it
  // is set, so that is the file read, and the home's is not.
  const config = temporary();
  assert.deepEqual(settingsArguments({ HOME: home, CLAUDE_CONFIG_DIR: config }, cwd, TABLE), flag({ beta: 1 }));
  writeFileSync(join(config, 'settings.json'), '{"beta":0}');
  assert.deepEqual(settingsArguments({ HOME: home, CLAUDE_CONFIG_DIR: config }, cwd, TABLE), []);
});

test('the shipped table leaves out attribution of Claude Code\'s own', () => {
  const { home, cwd } = places();
  const hidden = flag({ attribution: { commit: '', pr: '' } });
  assert.deepEqual(settingsArguments({ HOME: home }, cwd), hidden);
  // Either spelling of the decision — the current one and the deprecated one.
  for (const settings of ['{"attribution":{"pr":"Ours"}}', '{"includeCoAuthoredBy":true}']) {
    const launch = places();
    writeFileSync(join(launch.cwd, '.claude/settings.json'), settings);
    assert.deepEqual(settingsArguments({ HOME: launch.home }, launch.cwd), [], settings);
  }
});

test('the launcher evaluates those words, for the environment it runs in', () => {
  const { home, cwd } = places();
  const words = () => {
    const result = spawnSync(process.execPath, [join(src, 'harness/claude.ts'), 'settings'],
      { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(words(), `${flag({ attribution: { commit: '', pr: '' } }).join(' ')}\n`);
  writeFileSync(join(cwd, '.claude/settings.json'), '{"includeCoAuthoredBy":false}');
  assert.equal(words(), '\n');
  // Any other usage is a launcher that no longer matches this module.
  const wrong = spawnSync(process.execPath, [join(src, 'harness/claude.ts')], { encoding: 'utf8' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /usage: claude\.ts settings/);
});
