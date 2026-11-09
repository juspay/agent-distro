/**
 * The attribution default the Claude launcher asks this module for, without a
 * running harness: which settings files of the user's stand it down, and the
 * shell words the launcher evaluates.
 *
 * Usage: node check-adapter.ts SRC HARNESS_DIR
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const src = process.argv[2]!;
const { attributionArguments } = await import(join(src, 'harness/claude.ts'));

/** Empty attribution text: Claude Code ends a commit or a PR with none of its own. */
const HIDDEN = ['--settings', `'{"attribution":{"commit":"","pr":""}}'`];
const temporary = () => mkdtempSync(join(tmpdir(), 'claude-adapter-'));

/** A home and a launch directory, each with a `.claude` to put settings in. */
function places() {
  const home = temporary();
  const cwd = temporary();
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(cwd, '.claude'));
  return { home, cwd };
}

test('attribution the user has not decided is hidden', () => {
  const { home, cwd } = places();
  assert.deepEqual(attributionArguments({ HOME: home }, cwd), HIDDEN);
  // Settings that say nothing about attribution leave the default standing.
  writeFileSync(join(home, '.claude/settings.json'), '{"model":"sonnet"}');
  writeFileSync(join(cwd, '.claude/settings.json'), '{"permissions":{"allow":[]}}');
  writeFileSync(join(cwd, '.claude/settings.local.json'), '{}');
  assert.deepEqual(attributionArguments({ HOME: home }, cwd), HIDDEN);
  // A file Claude Code cannot read decides nothing there either.
  writeFileSync(join(home, '.claude/settings.json'), '{"attribution"');
  assert.deepEqual(attributionArguments({ HOME: home }, cwd), HIDDEN);
  // A launch with neither a home nor a working directory has nothing of the
  // user's to read, and still hides it.
  assert.deepEqual(attributionArguments({}, undefined), HIDDEN);
});

test("a settings file of the user's decides attribution itself", () => {
  const decisions = ['{"attribution":{"commit":""}}', '{"attribution":{"pr":"Ours"}}',
    '{"includeCoAuthoredBy":true}', '{"attribution":false}'];
  for (const settings of decisions) {
    for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
      const { home, cwd } = places();
      writeFileSync(join(cwd, file), settings);
      assert.deepEqual(attributionArguments({ HOME: home }, cwd), [], `${file}: ${settings}`);
    }
    const { home, cwd } = places();
    writeFileSync(join(home, '.claude/settings.json'), settings);
    assert.deepEqual(attributionArguments({ HOME: home }, cwd), [], settings);
  }
  // CLAUDE_CONFIG_DIR is where Claude Code keeps the user's settings when it
  // is set, so that is the file read, and the home's is not.
  const { home, cwd } = places();
  const config = temporary();
  writeFileSync(join(home, '.claude/settings.json'), '{"attribution":{"commit":""}}');
  assert.deepEqual(attributionArguments({ HOME: home, CLAUDE_CONFIG_DIR: config }, cwd), HIDDEN);
  writeFileSync(join(config, 'settings.json'), '{"attribution":{"commit":""}}');
  assert.deepEqual(attributionArguments({ HOME: home, CLAUDE_CONFIG_DIR: config }, cwd), []);
});

test('the launcher evaluates those words, for the environment it runs in', () => {
  const { home, cwd } = places();
  const words = (environment: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(process.execPath, [join(src, 'harness/claude.ts'), 'attribution'],
      { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...environment } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(words(), `${HIDDEN.join(' ')}\n`);
  writeFileSync(join(cwd, '.claude/settings.json'), '{"includeCoAuthoredBy":false}');
  assert.equal(words(), '\n');
  // Any other usage is a launcher that no longer matches this module.
  const wrong = spawnSync(process.execPath, [join(src, 'harness/claude.ts')], { encoding: 'utf8' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /usage: claude\.ts attribution/);
});
