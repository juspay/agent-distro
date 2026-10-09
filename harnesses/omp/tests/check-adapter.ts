/**
 * OMP config defaults without starting OMP: src/harness/omp.ts against
 * expected files. Each expectation is what the ruamel.yaml filler that
 * preceded it wrote, except where the PR that ported it documents a layout
 * difference (marked below); a `yaml` release that changes any of them fails here.
 *
 * Usage: node check-adapter.ts SRC HARNESS_DIR
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const [src] = process.argv.slice(2);
const script = join(src, 'harness/omp.ts');
const work = mkdtempSync(join(tmpdir(), 'omp-adapter-'));
// The two layers the launcher passes: every profile's, then the gateway's in
// effect, which omp.ts builds from the gateway itself.
const always = join(work, 'always.yml');
writeFileSync(always, 'hideThinkingBlock: true\n');
const gatewayJson = JSON.stringify({ url: 'https://gateway.test', keyEnv: 'KEY', models: { large: 'open-large', small: 'open-small' } });
const gateway = ['--gateway', gatewayJson];
// The layer the launcher wrote when the gateway was built in.
const builtGateway = join(work, 'gateway.yml');
writeFileSync(builtGateway, 'modelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n'
  + '  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n');

function fill(config: string, layers = [always, ...gateway]) {
  return spawnSync(process.execPath, [script, config, ...layers], { encoding: 'utf8' });
}

// [name, config.yml before, config.yml after or null when the launch must stop]
const cases: [string, string, string | null][] = [
  ["empty", "", "hideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["comment-only", "# my settings", "# my settings\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["comment-only-nl", "# a\n\n# b\n", "# a\n\n# b\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["setup", "setupVersion: 2\n", "setupVersion: 2\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["old", "# user settings\nsetupVersion: 2\nmodelRoles:\n  default: 'anthropic/expensive:high' # keep choice\n", "# user settings\nsetupVersion: 2\nmodelRoles:\n  default: 'anthropic/expensive:high' # keep choice\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\nhideThinkingBlock: true\ntask:\n  showResolvedModelBadge: true\n"],
  ["full", "modelRoles:\n  default: x\n  slow: y\n  smol: z\n  task: w\ntask:\n  showResolvedModelBadge: false\nhideThinkingBlock: false\n", "modelRoles:\n  default: x\n  slow: y\n  smol: z\n  task: w\ntask:\n  showResolvedModelBadge: false\nhideThinkingBlock: false\n"],
  ["quotes", "a: \"double\"\nb: 'single'\nc: plain # trailing\n# between\nd:\n  - x\n  - \"y\"\ne: [1, 2]\nf: {g: h}\n", "a: \"double\"\nb: 'single'\nc: plain # trailing\n# between\nd:\n- x\n- \"y\"\ne: [1, 2]\nf: {g: h}\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["seq-noindent", "list:\n- a\n- b\nnested:\n  inner:\n  - c\n", "list:\n- a\n- b\nnested:\n  inner:\n  - c\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["long", "long: word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word \n", "long: word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["multiline", "block: |\n  line one\n  line two\nfolded: >\n  folded text\n  here\n", "block: |\n  line one\n  line two\nfolded: >\n  folded text here\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["anchors", "base: &b\n  k: v\nother: *b\n", "base: &b\n  k: v\nother: *b\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["task-partial", "task:\n  other: 1 # keep\n", "task:\n  other: 1 # keep\n  showResolvedModelBadge: true\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\n"],
  ["tilde", "~\n", "hideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["docstart", "---\nkey: v\n", "---\nkey: v\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["unicode", "name: \"h\u00e9llo \u2713\"\n", "name: \"h\u00e9llo \u2713\"\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\ntask:\n  showResolvedModelBadge: true\n"],
  ["bad-roles", "modelRoles: []\n", null],
  ["null-roles", "modelRoles: null\n", null],
  ["invalid", "modelRoles: [", null],
  ["list-root", "- a\n", null],
  ["scalar-root", "just text\n", null],
  ["task-null", "task: null\n", null],
  ["alias-section", "base: &r {default: mine}\nmodelRoles: *r\n", "base: &r {default: mine, slow: litellm/open-large, smol: litellm/open-small, task: litellm/open-large}\nmodelRoles: *r\nhideThinkingBlock: true\ntask:\n  showResolvedModelBadge: true\n"],
  ["merge", "common: &c {modelRoles: {default: mine}}\n<<: *c\n", "common: &c {modelRoles: {default: mine, slow: litellm/open-large, smol: litellm/open-small, task: litellm/open-large}}\n<<: *c\nhideThinkingBlock: true\ntask:\n  showResolvedModelBadge: true\n"],
  ["merge-seq", "a: &a {x: 1}\nb: &b {task: {other: 2}}\n<<: [*a, *b]\n", "a: &a {x: 1}\nb: &b {task: {other: 2, showResolvedModelBadge: true}}\n<<: [*a, *b]\nhideThinkingBlock: true\nmodelRoles:\n  default: litellm/open-large\n  slow: litellm/open-large\n  smol: litellm/open-small\n  task: litellm/open-large\n"],
  ["merge-own-wins", "common: &c {hideThinkingBlock: false}\n<<: *c\nmodelRoles: {default: own}\n", "common: &c {hideThinkingBlock: false}\n<<: *c\nmodelRoles: {default: own, slow: litellm/open-large, smol: litellm/open-small, task: litellm/open-large}\ntask:\n  showResolvedModelBadge: true\n"],
];
// Layouts that differ from ruamel: `yaml` never folds a line (ruamel folded
// plain scalars and flow collections at 80 columns), re-flows a `>` block,
// and keeps a leading `---`.
const layoutDiffers = new Set(['long', 'multiline', 'docstart', 'alias-section', 'merge', 'merge-own-wins']);

test('yaml is the major version these expectations were written for', () => {
  const pin = JSON.parse(readFileSync(join(src, '../node_modules/yaml/package.json'), 'utf8'));
  assert.equal(pin.version.split('.')[0], '2', `yaml ${pin.version}: review omp.ts and these cases first`);
});

for (const [name, before, after] of cases) {
  test(`${name}${layoutDiffers.has(name) ? ' (layout differs from ruamel)' : ''}`, () => {
    const config = join(work, `${name}.yml`);
    writeFileSync(config, before);
    const result = fill(config);
    if (after === null) {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /^omp: cannot fill config defaults in /);
      assert.equal(readFileSync(config, 'utf8'), before);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(config, 'utf8'), after);
    }
  });
}

test('a config needing nothing is not rewritten', () => {
  const config = join(work, 'complete.yml');
  writeFileSync(config, cases.find(([name]) => name === 'full')![1]);
  const before = statSync(config, { bigint: true });
  assert.equal(fill(config).status, 0);
  const after = statSync(config, { bigint: true });
  assert.deepEqual([after.ino, after.mtimeNs], [before.ino, before.mtimeNs]);
});

test('a config that is not UTF-8 stops the launch unchanged', () => {
  const config = join(work, 'latin1.yml');
  const bytes = Buffer.from('# caf\xe9\nsetupVersion: 2\n', 'latin1');
  writeFileSync(config, bytes);
  const result = fill(config);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(readFileSync(config), bytes);
});

test('mode and symlink are kept; no temporary file is left', () => {
  const directory = join(work, 'linked');
  mkdirSync(directory);
  const real = join(directory, 'real.yml');
  writeFileSync(real, 'setupVersion: 2\n');
  chmodSync(real, 0o640);
  symlinkSync('real.yml', join(directory, 'config.yml'));
  assert.equal(fill(join(directory, 'config.yml'), [always]).status, 0);
  assert.ok(lstatSync(join(directory, 'config.yml')).isSymbolicLink());
  // One access: the descriptor both the content and the mode come from.
  const fd = openSync(real, 'r');
  try {
    assert.equal(fstatSync(fd).mode & 0o777, 0o640);
    assert.equal(readFileSync(fd, 'utf8'), 'setupVersion: 2\nhideThinkingBlock: true\n');
  } finally {
    closeSync(fd);
  }
  assert.deepEqual(readdirSync(directory).sort(), ['config.yml', 'real.yml']);
});

test('the gateway layer is the one the build used to write', () => {
  const [built, launched] = ['built', 'launched'].map((name) => join(work, `${name}.yml`));
  writeFileSync(built, '# mine\n');
  writeFileSync(launched, '# mine\n');
  assert.equal(fill(built, [always, builtGateway]).status, 0);
  assert.equal(fill(launched).status, 0);
  assert.equal(readFileSync(launched, 'utf8'), readFileSync(built, 'utf8'));
});

test('an unwritable agent directory only warns', () => {
  const directory = join(work, 'readonly');
  mkdirSync(directory);
  chmodSync(directory, 0o500);
  try {
    const result = fill(join(directory, 'config.yml'));
    // Root ignores the mode; the warning is only checked where it applies.
    if (process.getuid?.() !== 0) assert.match(result.stderr, /^omp: warning: cannot fill config defaults/);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    chmodSync(directory, 0o700);
  }
});
