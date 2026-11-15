/**
 * `agent-distro --models HARNESS` without a VM: a harness that cannot list
 * answers `unlisted` from the real package; each harness that can is read
 * from what its list command prints, run through a stand-in launcher; a list
 * command that fails, or prints something its reader does not know, fails
 * the command with the harness's words and never answers an empty list; and
 * the answer's type and how a launch takes a model.
 *
 * Usage: node check-models.ts SRC AGENT_DISTRO
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// Erased at run time; the modules themselves come from SRC.
import type { ModelSource, Models } from '../src/models.ts';

const [src, agentDistro] = process.argv.slice(2);
const { parseModels, launchWords } = await import(join(src, 'models.ts'));
const { listModels } = await import(join(src, 'models-cli.ts'));
// Each listing harness's own word on its models, from its adapter.
const sources: Record<'omp' | 'opencode' | 'pi', ModelSource> = {
  omp: (await import(join(src, 'harness', 'omp.ts'))).models,
  opencode: (await import(join(src, 'harness', 'opencode.ts'))).models,
  pi: (await import(join(src, 'harness', 'pi.ts'))).models,
};

// Claude Code and Codex have no list command: the package answers without
// starting either, and says how a launch names a model.
for (const harness of ['claude', 'codex']) {
  const answer: Models = parseModels(JSON.parse(execFileSync(agentDistro, ['--models', harness], { encoding: 'utf8' })));
  assert.deepEqual(answer, { launch: { kind: 'flag', flag: '--model' }, models: { kind: 'unlisted' } });
}
// The command takes exactly one harness, one the package carries.
for (const [args, message] of [
  [['--models'], /usage: agent-distro --models <harness>/],
  [['--models', 'claude', 'extra'], /usage: agent-distro --models <harness>/],
  [['--models', 'nope'], /--models takes one of .*claude/],
] as const) {
  const result = spawnSync(agentDistro, args, { encoding: 'utf8' });
  assert.equal(result.status, 2, args.join(' '));
  assert.equal(result.stdout, '');
  assert.match(result.stderr, message);
}

// The package says what its picker answers, and answers it: a consumer reads
// the file instead of trying a flag an older package would launch with.
const answers = readFileSync(join(dirname(dirname(agentDistro)), 'share', 'agent-distro', 'answers'), 'utf8');
assert.deepEqual(answers.trimEnd().split('\n'), ['--list', '--models']);
assert.equal(spawnSync(agentDistro, ['--list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status, 0);

// A stand-in launcher: prints `stdout` and `stderr`, exits `status`, and
// records the arguments it was given.
const work = mkdtempSync(join(tmpdir(), 'check-models-'));
function launcher(name: string, stdout: string, { stderr = '', status = 0 } = {}) {
  const path = join(work, name);
  writeFileSync(join(work, `${name}.out`), stdout);
  writeFileSync(join(work, `${name}.err`), stderr);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > ${work}/${name}.args\n`
    + `cat ${work}/${name}.out\ncat ${work}/${name}.err >&2\nexit ${status}\n`);
  chmodSync(path, 0o755);
  return path;
}
const argsOf = (name: string) => readFileSync(join(work, `${name}.args`), 'utf8').trimEnd().split('\n');

// OMP: each model's selector, so one id served by two providers is two ids.
const ompJson = JSON.stringify({
  models: [
    { provider: 'anthropic', kind: 'chat', id: 'claude-fable-5', selector: 'anthropic/claude-fable-5', name: 'Claude Fable 5' },
    { provider: 'litellm', kind: 'chat', id: 'claude-fable-5', selector: 'litellm/claude-fable-5', name: 'Claude Fable 5' },
  ],
});
const omp = listModels('omp', launcher('omp', ompJson, { stderr: 'agent-distro profile: using juspay\n' }), sources.omp);
assert.deepEqual(argsOf('omp'), ['models', '--json']);
assert.deepEqual(omp, {
  launch: { kind: 'flag', flag: '--model' },
  models: { kind: 'listed', ids: ['anthropic/claude-fable-5', 'litellm/claude-fable-5'] },
});

// OpenCode: one provider/id a line; its model goes in a config layer.
const opencode = listModels('opencode', launcher('opencode', 'opencode-go/beam-free\nlitellm/open-large\n'), sources.opencode);
assert.deepEqual(argsOf('opencode'), ['models']);
assert.deepEqual(opencode.models, { kind: 'listed', ids: ['opencode-go/beam-free', 'litellm/open-large'] });
assert.deepEqual(opencode.launch, { kind: 'config', variable: 'OPENCODE_CONFIG_CONTENT', key: 'model' });

// Pi: its table's provider and model columns, and "none" as an empty list.
const piTable = [
  'provider  model              context  max-out  thinking  images',
  'litellm   claude-opus-4-6    128K     16.4K    no        no    ',
  'openai    gpt-5.2            400K     128K     yes       yes   ',
  '',
].join('\n');
const pi = listModels('pi', launcher('pi', piTable), sources.pi);
assert.deepEqual(argsOf('pi'), ['--list-models']);
assert.deepEqual(pi.models, { kind: 'listed', ids: ['litellm/claude-opus-4-6', 'openai/gpt-5.2'] });
const none = listModels('pi', launcher('pi-none', 'No models available. Use /login to log into a provider via OAuth or API key. See:\n'),
  sources.pi);
assert.deepEqual(none.models, { kind: 'listed', ids: [] });

// A list command that fails is a failure carrying its words, not a list.
assert.throws(
  () => listModels('omp', launcher('omp-fails', '', { stderr: 'agent-distro: error: cannot prompt for LITELLM_API_KEY (stdin is not a terminal).\n', status: 1 }),
    sources.omp),
  /omp models --json exited 1:\nagent-distro: error: cannot prompt for LITELLM_API_KEY/,
);
// So is output the reader does not recognize.
for (const [harness, stdout, message] of [
  ['omp', '{"error":"offline"}', /omp models --json printed what agent-distro cannot read: no models array/],
  ['omp', 'not json', /omp models --json printed what agent-distro cannot read/],
  // An id the harness printed is refused by the answer's own type, naming it.
  ['omp', '{"models":[{"selector":"a b"}]}', /models\.models\.ids\[0\] is empty or contains whitespace/],
  ['opencode', 'beam-free\n', /not provider\/id/],
  ['pi', 'Warning: something\n', /not its table header/],
] as const) {
  assert.throws(() => listModels(harness, launcher(`${harness}-odd`, stdout), sources[harness]), message, `${harness}: ${stdout}`);
}

// The answer's type, each refusal naming the field.
const good = { launch: { kind: 'flag', flag: '--model' }, models: { kind: 'listed', ids: ['a/b'] } };
for (const [bad, message] of [
  [{ ...good, extra: 1 }, /models has unknown field extra/],
  [{ ...good, launch: { kind: 'env' } }, /models\.launch\.kind is not flag or config/],
  [{ ...good, launch: { kind: 'flag', flag: 'model' } }, /models\.launch\.flag is not an option/],
  [{ ...good, launch: { kind: 'config', variable: '1X', key: 'model' } }, /models\.launch\.variable is not a variable name/],
  [{ ...good, models: { kind: 'unlisted', ids: [] } }, /models\.models has unknown field ids/],
  [{ ...good, models: { kind: 'listed' } }, /models\.models\.ids is missing/],
  [{ ...good, models: { kind: 'listed', ids: ['a b'] } }, /models\.models\.ids\[0\] is empty or contains whitespace/],
  [{ ...good, models: { kind: 'listed', ids: ['a/b', 'a/b'] } }, /names a\/b twice/],
  [{ ...good, models: { kind: 'none' } }, /models\.models\.kind is not listed or unlisted/],
] as const) {
  assert.throws(() => parseModels(structuredClone(bad)), message, JSON.stringify(bad));
}

// How a launch takes a model: a flag before the harness's own arguments, or
// a config layer in its environment.
assert.deepEqual(launchWords({ kind: 'flag', flag: '--model' }, 'anthropic/claude-fable-5'),
  { env: {}, args: ['--model', 'anthropic/claude-fable-5'] });
assert.deepEqual(launchWords({ kind: 'config', variable: 'OPENCODE_CONFIG_CONTENT', key: 'model' }, 'litellm/open-large'),
  { env: { OPENCODE_CONFIG_CONTENT: '{"model":"litellm/open-large"}' }, args: [] });
assert.throws(() => launchWords({ kind: 'flag', flag: '--model' }, 'two words'), /contains whitespace/);

console.log(`--models: unlisted for claude and codex; omp ${omp.models.kind}, opencode, pi read; failures fail`);
