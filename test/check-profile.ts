/**
 * The profile in effect without a VM or a real nix: discovery up to the git
 * root, the stack and how it composes, references and their offline fallback, the evaluation's
 * isolation, cache and upkeep, nixpkgs fetched only for packages, the
 * no-compile policy for packages, and the launch that uses it all. A fake nix
 * on PATH logs every call; evaluate.nix itself runs in the VM tests.
 *
 * Usage: node check-profile.ts SRC
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const [src] = process.argv.slice(2);
const profile = await import(join(src, 'profile/resolve.ts'));
const listing = await import(join(src, 'listing.ts'));
const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const DAY = 24 * 60 * 60 * 1000;
// The shell launchers run in; a build has it as SHELL, not on PATH.
const BASH = process.env.SHELL || 'bash';

const temporary = () => mkdtempSync(join(tmpdir(), 'profile-'));

/**
 * A nix that answers from files: `eval` prints `<file>.json` beside the
 * profile it is asked about (its packages null when they are not empty and
 * no nixpkgs was given), keeping its arguments and environment in
 * `<bin>/eval.json`; `flake prefetch` maps a reference to
 * `<bin>/refs/<reference>` (a JSON answer), and fails printing no error for
 * `silent:`; `build --dry-run` lists the
 * derivations in `<bin>/miss`; `build --no-link` creates the package's output.
 */
const bin = temporary();
const log = join(bin, 'log');
writeFileSync(join(bin, 'nix'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
const bin = ${JSON.stringify(bin)};
if (args[0] === 'eval') {
  // import "evaluate.nix" (builtins.fromJSON "<JSON, with \\$ for $>")
  const expr = args[args.indexOf('--expr') + 1];
  const literal = expr.slice(expr.indexOf('(builtins.fromJSON ') + 19, -1).replaceAll('\\$', '$');
  const given = JSON.parse(JSON.parse(literal));
  fs.writeFileSync(path.join(bin, 'eval.json'), JSON.stringify({ args, given, env: process.env }));
  if (!fs.existsSync(given.file + '.json')) { console.error('error: undefined variable'); process.exit(1); }
  const answer = JSON.parse(fs.readFileSync(given.file + '.json', 'utf8'));
  if (given.nixpkgs === null && answer.packages?.length) answer.packages = null;
  process.stdout.write(JSON.stringify(answer));
} else if (args[0] === 'flake' && args[1] === 'prefetch') {
  const answer = path.join(bin, 'refs', encodeURIComponent(args.at(-1)));
  if (args.at(-1).startsWith('silent:')) { console.log('fetching\\nhalfway'); process.exit(3); }
  if (!fs.existsSync(answer)) { console.error('error: cannot fetch'); process.exit(1); }
  process.stdout.write(fs.readFileSync(answer, 'utf8'));
} else if (args[0] === 'build' && args.includes('--dry-run')) {
  const miss = path.join(bin, 'miss');
  if (fs.existsSync(miss)) console.error('these 1 derivations will be built:\\n  ' + fs.readFileSync(miss, 'utf8').trim());
} else if (args[0] === 'derivation') {
  const miss = fs.readFileSync(path.join(bin, 'miss'), 'utf8').trim();
  console.log(JSON.stringify({ [miss]: { name: 'uncached-1.0', env: {} } }));
} else if (args[0] === 'build') {
  const out = fs.readFileSync(path.join(bin, 'outs', encodeURIComponent(args[2])), 'utf8');
  fs.mkdirSync(path.join(out, 'bin'), { recursive: true });
} else { console.error('unexpected: ' + args.join(' ')); process.exit(1); }
`);
chmodSync(join(bin, 'nix'), 0o755);
mkdirSync(join(bin, 'refs'));
mkdirSync(join(bin, 'outs'));
process.env.PATH = `${bin}:${process.env.PATH}`;
const calls = (what: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith(what)).length : 0);

/** A fetchable reference: `nix flake prefetch` answers it with `directory`'s tree. */
function reference(name: string, storePath: string, dir?: string) {
  writeFileSync(join(bin, 'refs', encodeURIComponent(name)),
    JSON.stringify({ storePath, locked: dir ? { dir } : {}, original: dir ? { dir } : {} }));
}

const VANILLA = { name: 'vanilla', description: 'Upstream harnesses with your own provider', env: {}, settings: {} };
const info = { default: 'vanilla', builtins: [VANILLA], nixpkgs: '/nix/store/00000000000000000000000000000000-nixpkgs', system: 'x86_64-linux' };
/** What the fake nix last evaluated: its arguments, what it was given and its environment. */
const lastEvaluation = () => JSON.parse(readFileSync(join(bin, 'eval.json'), 'utf8'));

/** Run `body` collecting what it writes to stderr. */
function stderrOf(body: () => void): string {
  const write = process.stderr.write;
  let written = '';
  process.stderr.write = ((chunk: string) => {
    written += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    body();
  } finally {
    process.stderr.write = write;
  }
  return written;
}

/** An `agent-distro.nix` and what the fake nix evaluates it to. */
function profileFile(directory: string, evaluated: Record<string, unknown>, text = '{ }') {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'agent-distro.nix');
  writeFileSync(file, text);
  writeFileSync(file + '.json', JSON.stringify({
    description: '', plugins: [], env: {}, settings: {}, deprecated: [], packages: [], ...evaluated,
  }));
  return file;
}

function plugin(name: string): string {
  const root = join(temporary(), name);
  mkdirSync(join(root, 'skills/hello'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ $schema: SCHEMA, name }));
  writeFileSync(join(root, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: Hello\n---\n');
  return root;
}

const resolve = (selection: object, env: NodeJS.ProcessEnv = {}) =>
  profile.resolveProfile(info, [selection], { XDG_CACHE_HOME: temporary(), ...env });

test('discovery goes from the working directory up to the git root, and no further', () => {
  const outer = temporary();
  writeFileSync(join(outer, 'agent-distro.nix'), '{ }');
  const repo = join(outer, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'a/b'), { recursive: true });
  // A file above the repository is not the repository's.
  assert.equal(profile.discover(join(repo, 'a/b')), null);
  writeFileSync(join(repo, 'agent-distro.nix'), '{ }');
  assert.equal(profile.discover(join(repo, 'a/b')), join(repo, 'agent-distro.nix'));
  // The nearest wins.
  writeFileSync(join(repo, 'a/agent-distro.nix'), '{ }');
  assert.equal(profile.discover(join(repo, 'a/b')), join(repo, 'a/agent-distro.nix'));
  // Outside any repository there is none, even beside the working directory.
  assert.equal(profile.discover(outer), null);
  // A worktree's `.git` is a file.
  const worktree = temporary();
  writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n');
  writeFileSync(join(worktree, 'agent-distro.nix'), '{ }');
  assert.equal(profile.discover(worktree), join(worktree, 'agent-distro.nix'));
});

test('the stack: a positional profile alone, else the built-in one, AI_PROFILE and the repository, bottom to top', () => {
  const repo = temporary();
  mkdirSync(join(repo, '.git'));
  const file = join(repo, 'agent-distro.nix');
  writeFileSync(file, '{ }');
  const outside = temporary();
  const select = (positional: string | undefined, cwd: string | undefined, env: NodeJS.ProcessEnv = {}) =>
    profile.select(positional, cwd, env, info);
  const builtIn = { source: 'builtin', origin: 'vanilla' };
  const variable = { source: 'variable', origin: 'github:a/b' };
  const repository = { source: 'repository', origin: file };
  assert.deepEqual(select('./mine', repo, { AI_PROFILE: 'github:a/b' }), [{ source: 'positional', origin: './mine' }]);
  assert.deepEqual(select(undefined, repo, { AI_PROFILE: 'github:a/b' }), [builtIn, variable, repository]);
  assert.deepEqual(select(undefined, repo), [builtIn, repository]);
  assert.deepEqual(select(undefined, outside, { AI_PROFILE: 'github:a/b' }), [builtIn, variable]);
  assert.deepEqual(select(undefined, outside, { AI_PROFILE: '' }), [builtIn]);
  assert.deepEqual(select(undefined, undefined), [builtIn]);
});

/** A team profile's environment and settings: a value, a secret, and a harness section. */
const PROFILE_ENV = { LITELLM_BASE_URL: 'https://team.test', LITELLM_API_KEY: { secret: true, hint: 'team hint' } };
const PROFILE_SETTINGS = { omp: { modelRoles: { default: 'litellm/large' } } };

/** A package already in the store, so resolving it fetches nothing. */
function stored(name: string) {
  const out = join(temporary(), name);
  mkdirSync(join(out, 'bin'), { recursive: true });
  return { name, drvPath: join(out, `${name}.drv`), out, bin: join(out, 'bin') };
}

test('a repository\'s profile composes over AI_PROFILE, which composes over the built-in one', () => {
  const team = plugin('team');
  const mine = plugin('mine');
  const teamPackage = stored('team-tool');
  const repoPackage = stored('repo-tool');
  const elsewhere = temporary();
  profileFile(elsewhere, {
    name: 'elsewhere', description: 'Team', plugins: [team], env: PROFILE_ENV, settings: PROFILE_SETTINGS, packages: [teamPackage],
  });
  const repo = temporary();
  mkdirSync(join(repo, '.git'));
  const file = profileFile(repo, { name: 'repo', description: 'Repo', plugins: [mine], packages: [repoPackage] });
  const env = { XDG_CACHE_HOME: temporary(), AI_PROFILE: elsewhere };
  const inEffect = (positional: string | undefined, cwd: string, environment: NodeJS.ProcessEnv = env) =>
    profile.resolveProfile(info, profile.select(positional, cwd, environment, info), environment);
  // Plugins and packages are both, the user's first; the repository sets no
  // env or settings, so the user's are in effect.
  const composed = inEffect(undefined, repo);
  assert.deepEqual(composed, {
    name: 'repo', description: 'Repo', source: 'repository', origin: file,
    over: { name: 'elsewhere', description: 'Team', source: 'variable', origin: elsewhere },
    keepsBuiltIn: true, plugins: [team, mine], env: PROFILE_ENV, settings: PROFILE_SETTINGS,
    paths: [teamPackage.bin, repoPackage.bin],
  });
  // Handed to the launcher as JSON, and accepted there.
  assert.ok(profile.isResolved(JSON.parse(JSON.stringify(composed))));
  assert.ok(!profile.isResolved({ ...composed, over: { name: 'a b' } }), 'what it is composed over is checked too');
  // Shown as both, the built-in one beneath never named.
  assert.equal(listing.nameText(composed), 'repo + elsewhere');
  assert.equal(listing.sourceText(composed), `from ${file} over AI_PROFILE=${elsewhere}`);
  // The repository's own env wins variable by variable, its own settings
  // harness by harness: the team's `omp` under the repository's `opencode`.
  const ownEnv = { LITELLM_BASE_URL: 'https://repo.test' };
  const ownSettings = { opencode: { model: 'litellm/large' } };
  profileFile(repo, { name: 'repo', description: 'Repo', plugins: [mine], env: ownEnv, settings: ownSettings }, '{ env = { }; }');
  const own = inEffect(undefined, repo);
  assert.deepEqual(own.env, { ...PROFILE_ENV, ...ownEnv });
  assert.deepEqual(own.settings, { ...PROFILE_SETTINGS, ...ownSettings });
  // Without AI_PROFILE the repository's is over the built-in one alone, and
  // names nothing beneath it.
  const alone = inEffect(undefined, repo, { XDG_CACHE_HOME: env.XDG_CACHE_HOME });
  assert.equal(alone.over, undefined);
  assert.deepEqual(alone.plugins, [mine]);
  assert.equal(listing.nameText(alone), 'repo');
  assert.equal(listing.sourceText(alone), `from ${file}`);
  // Outside the repository, AI_PROFILE over the built-in one.
  const variable = inEffect(undefined, temporary());
  assert.deepEqual([variable.name, variable.source, variable.over, variable.keepsBuiltIn, variable.plugins,
    variable.env, variable.settings],
    ['elsewhere', 'variable', undefined, true, [team], PROFILE_ENV, PROFILE_SETTINGS]);
  // A positional profile is that one, exactly: nothing beneath it.
  assert.deepEqual(inEffect(repo, repo), {
    name: 'repo', description: 'Repo', source: 'positional', origin: repo,
    keepsBuiltIn: false, plugins: [mine], env: ownEnv, settings: ownSettings, paths: [],
  });
});

test('a built-in name, in AI_PROFILE or positional, is that profile exactly; a repository\'s composes over it', () => {
  const TEAM = { name: 'team', description: 'Team', env: {}, settings: {} };
  const builtins = { ...info, default: 'team', builtins: [TEAM, VANILLA] };
  const inEffect = (positional: string | undefined, env: NodeJS.ProcessEnv, cwd = temporary()) =>
    profile.resolveProfile(builtins, profile.select(positional, cwd, env, builtins), { XDG_CACHE_HOME: temporary(), ...env });
  assert.deepEqual(profile.select(undefined, temporary(), { AI_PROFILE: 'vanilla' }, builtins), [{ source: 'variable', origin: 'vanilla' }]);
  // Not the launcher's own (`keepsBuiltIn` false): its plugins and environment are gone.
  assert.deepEqual(inEffect(undefined, { AI_PROFILE: 'vanilla' }), {
    ...VANILLA, source: 'variable', origin: 'vanilla', keepsBuiltIn: false, plugins: [], env: {}, settings: {}, paths: [],
  });
  assert.deepEqual(inEffect('vanilla', {}), {
    ...VANILLA, source: 'positional', origin: 'vanilla', keepsBuiltIn: false, plugins: [], env: {}, settings: {}, paths: [],
  });
  // The launcher's own name keeps its own.
  assert.deepEqual(inEffect(undefined, { AI_PROFILE: 'team' }), {
    ...TEAM, source: 'variable', origin: 'team', keepsBuiltIn: true, plugins: [], env: {}, settings: {}, paths: [],
  });
  assert.equal(inEffect(undefined, {}).keepsBuiltIn, true);
  // A repository over AI_PROFILE=vanilla composes over vanilla: no env or
  // settings unless it sets them, and vanilla named beneath it.
  const mine = plugin('mine');
  const repo = temporary();
  mkdirSync(join(repo, '.git'));
  const file = profileFile(repo, { name: 'repo', description: 'Repo', plugins: [mine] });
  assert.deepEqual(inEffect(undefined, { AI_PROFILE: 'vanilla' }, repo), {
    name: 'repo', description: 'Repo', source: 'repository', origin: file,
    over: { name: VANILLA.name, description: VANILLA.description, source: 'variable', origin: 'vanilla' },
    keepsBuiltIn: false, plugins: [mine], env: {}, settings: {}, paths: [],
  });
});

test('a built-in profile carries the environment and settings it was built with, held to the same rules', () => {
  const distribution = {
    ...info, default: 'team',
    builtins: [{ name: 'team', description: 'Built in', env: PROFILE_ENV, settings: PROFILE_SETTINGS }],
  };
  const inEffect = (which: typeof distribution) =>
    profile.resolveProfile(which, profile.select(undefined, temporary(), {}, which), { XDG_CACHE_HOME: temporary() });
  const built = inEffect(distribution);
  assert.deepEqual([built.name, built.keepsBuiltIn, built.env, built.settings],
    ['team', true, PROFILE_ENV, PROFILE_SETTINGS]);
  assert.ok(profile.isResolved(built));
  for (const [builtin, message] of [
    [{ name: 'wrong', description: '', env: { 'BAD NAME': 'x' }, settings: {} }, /built-in profile wrong: `env` `BAD NAME` is not an environment variable name/],
    [{ name: 'wrong', description: '', env: {}, settings: { pi: {} } }, /built-in profile wrong: `settings` `pi` is not a harness/],
  ] as const) {
    const broken = { ...info, default: 'wrong', builtins: [builtin] };
    assert.throws(() => inEffect(broken), message);
  }
});

test('each profile of the stack is cached on its own, and a second launch evaluates nothing', () => {
  const elsewhere = temporary();
  profileFile(elsewhere, { name: 'elsewhere' });
  const repo = temporary();
  mkdirSync(join(repo, '.git'));
  profileFile(repo, { name: 'repo' });
  const cache = temporary();
  const env = { XDG_CACHE_HOME: cache, AI_PROFILE: elsewhere };
  const stack = profile.select(undefined, repo, env, info);
  const start = calls('eval');
  profile.resolveProfile(info, stack, env);
  assert.equal(calls('eval') - start, 2, 'one evaluation per file');
  assert.equal(readdirSync(join(cache, 'agent-distro/profiles')).length, 2, 'one entry per file');
  assert.equal(profile.resolveProfile(info, stack, env).name, 'repo');
  assert.equal(calls('eval') - start, 2, 'both cached');
});

test('a profile of the stack that cannot be read is named as the user gave it', () => {
  const repo = temporary();
  mkdirSync(join(repo, '.git'));
  const file = profileFile(repo, { name: 'repo' });
  const inEffect = (cwd: string, env: NodeJS.ProcessEnv) =>
    profile.resolveProfile(info, profile.select(undefined, cwd, env, info), { XDG_CACHE_HOME: temporary(), ...env });
  assert.throws(() => inEffect(repo, { AI_PROFILE: 'github:no/team' }), /^Error: AI_PROFILE=github:no\/team: cannot fetch github:no\/team:/);
  const broken = temporary();
  mkdirSync(join(broken, '.git'));
  const brokenFile = join(broken, 'agent-distro.nix');
  writeFileSync(brokenFile, '{');
  const elsewhere = temporary();
  profileFile(elsewhere, { name: 'elsewhere' });
  assert.throws(() => inEffect(broken, { AI_PROFILE: elsewhere }),
    (error: Error) => error.message.startsWith(`${brokenFile}: cannot evaluate ${brokenFile}`) && !error.message.includes('AI_PROFILE'));
  assert.ok(existsSync(file));
});

test('a built-in name needs no nix; anything else that is not a reference is refused', () => {
  const before = calls('');
  assert.deepEqual(resolve({ source: 'variable', origin: 'vanilla' }), {
    ...VANILLA, source: 'variable', origin: 'vanilla', keepsBuiltIn: true, plugins: [], env: {}, settings: {}, paths: [],
  });
  assert.equal(calls(''), before);
  assert.throws(() => resolve({ source: 'variable', origin: 'nonesuch' }),
    /AI_PROFILE=nonesuch: not a built-in profile \(vanilla\) or a reference/);
  assert.throws(() => resolve({ source: 'positional', origin: './missing' }), /profile \.\/missing: no agent-distro\.nix at/);
});

test('a path reference, as the directory or the file; plugin paths stay where they are', () => {
  const own = plugin('own');
  const directory = temporary();
  const file = profileFile(directory, { name: 'mine', description: 'Mine', plugins: [own] });
  for (const origin of [directory, file]) {
    const resolved = resolve({ source: 'positional', origin });
    assert.deepEqual(resolved, {
      name: 'mine', description: 'Mine', source: 'positional', origin, keepsBuiltIn: false, plugins: [own],
      env: {}, settings: {}, paths: [],
    });
    assert.ok(profile.isResolved(resolved));
  }
  // Relative to the working directory, as typed.
  const cwd = process.cwd();
  try {
    process.chdir(directory);
    assert.equal(resolve({ source: 'positional', origin: '.' }).name, 'mine');
  } finally {
    process.chdir(cwd);
  }
});

test('flake references are fetched: the profile and its plugin references, every launch', () => {
  const tree = temporary();
  const file = profileFile(join(tree, 'sub'), { name: 'fetched', plugins: ['git+file:///plugins?dir=one', '/abs/plugin'] });
  reference('git+file:///profiles?dir=sub', tree, 'sub');
  reference('git+file:///plugins?dir=one', '/nix/store/11111111111111111111111111111111-source', 'one');
  const cache = temporary();
  const before = calls('flake prefetch');
  for (let i = 0; i < 2; i++) {
    const resolved = profile.resolveProfile(info, [{ source: 'variable', origin: 'git+file:///profiles?dir=sub' }], { XDG_CACHE_HOME: cache });
    assert.deepEqual(resolved.plugins, ['/nix/store/11111111111111111111111111111111-source/one', '/abs/plugin']);
  }
  assert.equal(calls('flake prefetch') - before, 4, 'the profile and its plugin reference, at each launch');
  // Offline, nix would fail downloading the global registry, which only an
  // indirect reference needs.
  assert.equal(calls('flake prefetch --option flake-registry  --json git+file:///profiles?dir=sub'), 2);
  reference('my-registry/sub', tree, 'sub');
  resolve({ source: 'variable', origin: 'my-registry/sub' });
  assert.equal(calls('flake prefetch --json my-registry/sub'), 1, 'an indirect reference keeps the registry');
  assert.ok(existsSync(file));
  assert.throws(() => resolve({ source: 'variable', origin: 'github:no/such' }), /AI_PROFILE=github:no\/such: cannot fetch github:no\/such:\nerror: cannot fetch/);
  // Nix failing without a word still says how it failed.
  assert.throws(() => resolve({ source: 'variable', origin: 'silent:x' }),
    /AI_PROFILE=silent:x: cannot fetch silent:x: nix exited with code 3 and printed no error; its last output: halfway$/);
});

test('the evaluation is cached per content and agent-distro build, and swept when unused', () => {
  const directory = temporary();
  const file = profileFile(directory, { name: 'cached' });
  const cache = temporary();
  const env = { XDG_CACHE_HOME: cache };
  const selection = { source: 'positional', origin: directory };
  const evaluations = () => calls('eval');
  const start = evaluations();
  profile.resolveProfile(info, [selection], env);
  profile.resolveProfile(info, [selection], env);
  assert.equal(evaluations() - start, 1, 'read once');
  const profiles = join(cache, 'agent-distro/profiles');
  const [first] = readdirSync(profiles);
  // New contents are a new evaluation, under a new key.
  writeFileSync(file, '{ name = "cached"; }');
  writeFileSync(file + '.json', JSON.stringify({
    name: 'edited', description: '', plugins: [], env: {}, settings: {}, deprecated: [], packages: [],
  }));
  assert.equal(profile.resolveProfile(info, [selection], env).name, 'edited');
  assert.equal(evaluations() - start, 2);
  assert.equal(readdirSync(profiles).length, 2);
  // A corrupt entry is evaluated again rather than failing the launch.
  const [current] = readdirSync(profiles).filter((name) => name !== first);
  writeFileSync(join(profiles, current, 'profile.json'), '{');
  assert.equal(profile.resolveProfile(info, [selection], env).name, 'edited');
  assert.equal(evaluations() - start, 3);
  // What no launch used for STALE_DAYS goes when something new is cached.
  const old = new Date(Date.now() - 15 * DAY);
  utimesSync(join(profiles, first), old, old);
  writeFileSync(file, '{ name = "again"; }');
  profile.resolveProfile(info, [selection], env);
  assert.ok(!readdirSync(profiles).includes(first), 'the stale entry is removed');
  assert.equal(readdirSync(profiles).length, 2);
  // Another agent-distro build evaluates afresh.
  const copy = join(temporary(), 'src');
  cpSync(src, copy, { recursive: true });
  // Its dependencies, beside it as in the runtime tree.
  symlinkSync(join(src, '../node_modules'), join(copy, '../node_modules'));
  return import(join(copy, 'profile/resolve.ts')).then((other) => {
    other.resolveProfile(info, [selection], env);
    assert.equal(evaluations() - start, 5);
  });
});

test('a file that is not a profile names what is wrong', () => {
  const broken = temporary();
  writeFileSync(join(broken, 'agent-distro.nix'), '{');
  assert.throws(() => resolve({ source: 'positional', origin: broken }), /cannot evaluate .*agent-distro\.nix:\nerror: undefined variable/);
  for (const [evaluated, message] of [
    [{ name: 'a b' }, /`name` must be one word without \//],
    [{ name: 'g', env: 'LITELLM_BASE_URL' }, /`env` must be an attribute set/],
    [{ name: 'g', env: { 'BAD NAME': 'x' } }, /`BAD NAME` is not an environment variable name/],
    [{ name: 'g', env: { KEY: 1 } }, /`KEY` must be a string, or `\{ secret = true; \}` with an optional `hint`/],
    [{ name: 'g', env: { KEY: { secret: false } } }, /`KEY` must be a string, or `\{ secret = true; \}`/],
    [{ name: 'g', env: { KEY: { secret: true, hint: 1 } } }, /`KEY\.hint` must be a string/],
    [{ name: 'g', settings: { pi: { } } }, /`pi` is not a harness whose configuration a profile sets \(omp, opencode\)/],
    [{ name: 'g', settings: { omp: 'roles' } }, /`omp` must be an attribute set/],
    [{ name: 'g', plugins: [1] }, /is not a profile/],
  ] as const) {
    assert.throws(() => resolve({ source: 'positional', origin: profileFile(temporary(), evaluated) }), message);
  }
});

test('a profile that still carries `gateway` is warned about at every launch', () => {
  const directory = temporary();
  // evaluate.nix reports it as deprecated (the VM tests run that); here the
  // resolver is what has to say so, from the cached evaluation as well.
  profileFile(directory, { name: 'old', deprecated: ['gateway'] });
  const env = { XDG_CACHE_HOME: temporary() };
  const selection = { source: 'positional', origin: directory };
  // A severity word is coloured on a terminal, as the sandbox's stderr is.
  const warns = () =>
    stderrOf(() => profile.resolveProfile(info, [selection], env)).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(warns(), /^agent-distro profile: warning: `gateway` is no longer read; see https:\/\/agent-distro\.nixos\.asia\/#profiles$/m);
  // The first launch evaluated the file; this one is served from the cache, so
  // a warning emitted only at evaluation time would never be seen again.
  const second = warns();
  assert.match(second, /`gateway` is no longer read/);
  assert.doesNotMatch(second, /evaluating/);
});

test('packages come from the binary cache or the launch stops naming them', () => {
  const store = temporary();
  const out = join(store, 'pkg-1.0');
  const drvPath = join(store, 'pkg-1.0.drv');
  writeFileSync(drvPath, '');
  writeFileSync(join(bin, 'outs', encodeURIComponent(`${drvPath}^*`)), out);
  const package_ = { name: 'pkg-1.0', drvPath, out, bin: join(out, 'bin') };
  const directory = temporary();
  profileFile(directory, { name: 'packaged', packages: [package_] });
  const cache = temporary();
  const env = { XDG_CACHE_HOME: cache };
  const selection = { source: 'positional', origin: directory };
  // Not in the store and nothing to compile: fetched with nix build --no-link.
  const builds = () => calls('build --no-link');
  const before = builds();
  const fetching = stderrOf(() => {
    assert.deepEqual(profile.resolveProfile(info, [selection], env).paths, [join(out, 'bin')]);
  });
  assert.match(fetching, /^agent-distro profile: fetching package pkg-1\.0 from the binary cache …$/m);
  assert.equal(builds() - before, 1);
  // Present: nothing to do.
  profile.resolveProfile(info, [selection], env);
  assert.equal(builds() - before, 1);
  // A cache miss stops the launch, naming the package, and builds nothing;
  // nothing is said to be fetched before the dry run has found it cached.
  rmSync(out, { recursive: true });
  writeFileSync(join(bin, 'miss'), '/nix/store/22222222222222222222222222222222-uncached-1.0.drv');
  try {
    const missed = stderrOf(() => assert.throws(() => profile.resolveProfile(info, [selection], env),
      /package pkg-1\.0 is not in the binary cache \(would build uncached-1\.0\); agent-distro never compiles/));
    assert.ok(!missed.includes('fetching package'), missed);
    assert.equal(builds() - before, 1);
  } finally {
    rmSync(join(bin, 'miss'));
  }
  // A collected derivation is evaluated again to get it back.
  rmSync(drvPath);
  const evaluations = calls('eval');
  assert.deepEqual(profile.resolveProfile(info, [selection], env).paths, [join(out, 'bin')]);
  // Twice: once to learn it has packages, once with nixpkgs.
  assert.equal(calls('eval') - evaluations, 2);
  assert.equal(builds() - before, 2);
});

test('a profile is evaluated restricted, without network or the user\'s environment', () => {
  const directory = temporary();
  const file = profileFile(directory, { name: 'isolated' });
  const config = process.env.NIX_CONFIG;
  process.env.SECRET = 'hunter2';
  process.env.NIX_CONFIG = 'access-tokens = github.com=secret';
  try {
    resolve({ source: 'positional', origin: directory });
    // nix's configuration is per command: this process's is untouched.
    assert.equal(process.env.NIX_CONFIG, 'access-tokens = github.com=secret');
  } finally {
    delete process.env.SECRET;
    if (config === undefined) delete process.env.NIX_CONFIG;
    else process.env.NIX_CONFIG = config;
  }
  const { args, given, env } = lastEvaluation();
  assert.deepEqual(given, { file, nixpkgs: null, system: 'x86_64-linux' });
  assert.equal(env.SECRET, undefined, 'the user\'s variables stay out');
  assert.equal(env.NIX_CONFIG, 'extra-experimental-features = nix-command flakes', 'and so does their NIX_CONFIG');
  assert.ok(env.PATH, 'nix still has what it needs');
  const option = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(option('restrict-eval'), 'true');
  assert.equal(option('allowed-uris'), '');
  assert.equal(option('nix-path'), '');
  const allowed = args.flatMap((arg: string, i: number) => (arg === '-I' ? [args[i + 1]] : []));
  assert.deepEqual(allowed, [directory, join(src, 'profile')], 'its directory and evaluate.nix, nothing else');
});

test('nixpkgs is fetched by its locked reference, and only for a profile with packages', () => {
  const nixpkgs = 'github:NixOS/nixpkgs/0000000000000000000000000000000000000000?narHash=sha256-AAAA%3D';
  const tree = temporary();
  reference(nixpkgs, tree);
  const referenced = { ...info, nixpkgs };
  const env = { XDG_CACHE_HOME: temporary() };
  const fetches = () => calls(`flake prefetch --option flake-registry  --json ${nixpkgs}`);
  const before = fetches();
  const bare = temporary();
  profileFile(bare, { name: 'bare' });
  profile.resolveProfile(referenced, [{ source: 'positional', origin: bare }], env);
  assert.equal(fetches(), before, 'no packages, no nixpkgs');
  const out = temporary();
  mkdirSync(join(out, 'bin'));
  const packaged = temporary();
  profileFile(packaged, { name: 'packaged', packages: [{ name: 'p', drvPath: join(out, 'p.drv'), out, bin: join(out, 'bin') }] });
  const evaluations = calls('eval');
  assert.deepEqual(profile.resolveProfile(referenced, [{ source: 'positional', origin: packaged }], env).paths, [join(out, 'bin')]);
  assert.equal(fetches() - before, 1);
  assert.equal(calls('eval') - evaluations, 2, 'once to learn it has packages, once with nixpkgs');
  const { args, given } = lastEvaluation();
  assert.equal(given.nixpkgs, tree);
  assert.ok(args.includes(tree), 'nixpkgs is readable to the evaluation');
  // Its tree already in the store: used as it is, never fetched.
  const stored = temporary();
  profile.resolveProfile({ ...referenced, nixpkgsPath: stored }, [{ source: 'positional', origin: packaged }], { XDG_CACHE_HOME: temporary() });
  assert.equal(fetches() - before, 1);
  assert.equal(lastEvaluation().given.nixpkgs, stored);
  // Gone from the store: fetched.
  profile.resolveProfile({ ...referenced, nixpkgsPath: join(stored, 'gone') }, [{ source: 'positional', origin: packaged }], { XDG_CACHE_HOME: temporary() });
  assert.equal(fetches() - before, 2);
  assert.equal(lastEvaluation().given.nixpkgs, tree);
});

test('without network, a reference uses its last store path, and says so', () => {
  const tree = temporary();
  profileFile(tree, { name: 'remembered', plugins: ['git+file:///offline-plugin'] });
  const pluginTree = temporary();
  reference('git+file:///offline-profile', tree);
  reference('git+file:///offline-plugin', pluginTree);
  const env = { XDG_CACHE_HOME: temporary() };
  const selection = { source: 'variable', origin: 'git+file:///offline-profile' };
  // The first launch says what keeps it waiting; a cached one says nothing.
  const first = stderrOf(() => profile.resolveProfile(info, [selection], env));
  assert.match(first, /^agent-distro profile: fetching git\+file:\/\/\/offline-profile …$/m);
  assert.match(first, /^agent-distro profile: evaluating .*agent-distro\.nix …$/m);
  assert.equal(stderrOf(() => profile.resolveProfile(info, [selection], env)), '');
  // Nix can no longer fetch either.
  rmSync(join(bin, 'refs', encodeURIComponent('git+file:///offline-profile')));
  rmSync(join(bin, 'refs', encodeURIComponent('git+file:///offline-plugin')));
  let resolved: { name: string; plugins: string[] } = { name: '', plugins: [] };
  const noted = stderrOf(() => {
    resolved = profile.resolveProfile(info, [selection], env);
  });
  assert.equal(resolved.name, 'remembered');
  assert.deepEqual(resolved.plugins, [pluginTree]);
  assert.match(noted, new RegExp(`AI_PROFILE=git\\+file:///offline-profile: cannot fetch git\\+file:///offline-profile; using ${tree}, from the last launch that could`));
  assert.match(noted, /cannot fetch git\+file:\/\/\/offline-plugin; using /);
  // --list --json too, its JSON intact on stdout.
  const infoFile = join(temporary(), 'info.json');
  writeFileSync(infoFile, JSON.stringify(info));
  const listed = spawnSync(process.execPath, [join(src, 'profile/cli.ts'), 'list', infoFile, JSON.stringify({ profiles: [{ name: 'vanilla', description: '', harnesses: [] }] }), '--json'],
    { encoding: 'utf8', cwd: temporary(), env: { PATH: process.env.PATH, ...env, AI_PROFILE: 'git+file:///offline-profile' } });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).profile.name, 'remembered');
  assert.match(listed.stderr, /cannot fetch git\+file:\/\/\/offline-profile; using /);
  // Gone from the store: nothing to fall back to.
  rmSync(tree, { recursive: true });
  assert.throws(() => profile.resolveProfile(info, [selection], env), /cannot fetch git\+file:\/\/\/offline-profile:\nerror: cannot fetch/);
  // Never fetched: likewise.
  assert.throws(() => resolve({ source: 'variable', origin: 'git+file:///never' }), /cannot fetch git\+file:\/\/\/never:\nerror: cannot fetch/);
});

test('a launch uses the profile in effect: its plugins over the built-in ones, with its env, settings and packages', () => {
  const own = plugin('own');
  const repo = temporary();
  mkdirSync(join(repo, '.git'));
  const env = { LITELLM_BASE_URL: 'https://gateway.test', LITELLM_API_KEY: { secret: true, hint: "it's here" } };
  profileFile(repo, { name: 'repo', plugins: [own], env, settings: { omp: { modelRoles: { default: 'litellm/large' } } } });
  // A repository that sets nothing, and a team profile that does.
  const bare = temporary();
  mkdirSync(join(bare, '.git'));
  const bareOwn = plugin('bare');
  profileFile(bare, { name: 'bare', plugins: [bareOwn] });
  const team = plugin('team');
  const elsewhere = temporary();
  profileFile(elsewhere, { name: 'elsewhere', plugins: [team], env: { TEAM_URL: 'https://team.test' }, settings: { omp: { task: { showResolvedModelBadge: true } } } });
  const kept = plugin('kept');
  const description = join(temporary(), 'description.json');
  writeFileSync(description, JSON.stringify({ root: kept, version: '1.0.0', manifest: { $schema: SCHEMA, name: 'kept' }, skills: {}, mcpServers: {}, reports: [] }));
  const args = join(temporary(), 'args.json');
  writeFileSync(args, JSON.stringify({
    harness: 'claude', bash: '/bin/sh', env: '/usr/bin/env', profile: [{ description, dir: '/built-in/kept' }], info,
  }));
  let noticed = '';
  // What the launcher's shell hands the harness: its command line, the
  // secrets it prompts for, the settings of this harness, the environment
  // itself, and the profile hand-over it unsets.
  const handedOver = [
    '"$launched"', '"${profile_env_secrets[*]}"', '"$profile_settings"',
    '"${LITELLM_BASE_URL-}"', '"${TEAM_URL-}"', '"${AGENT_DISTRO_PROFILE-unset}"',
  ].join(' ');
  const launch = (cwd: string, environment: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(process.execPath, [join(src, 'plugin/launch-cli.mjs'), args],
      { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, XDG_CACHE_HOME: temporary(), ...environment } });
    assert.equal(result.status, 0, result.stderr);
    noticed = result.stderr;
    const output = spawnSync(BASH, ['-euc', `${result.stdout} printf '%s\\n' ${handedOver}`],
      { encoding: 'utf8', env: { AGENT_DISTRO_PROFILE: environment.AGENT_DISTRO_PROFILE ?? '' } });
    assert.equal(output.status, 0, output.stderr);
    return output.stdout.split('\n');
  };
  // Outside the repository: the built-in profile, as the launcher was built,
  // and nothing said about it.
  assert.deepEqual(launch(temporary()), ['--plugin-dir /built-in/kept', '', '', '', '', 'unset', '']);
  assert.equal(noticed, '');
  // Inside it: the repository's plugin over the built-in one, its environment
  // exported — the value here, the secret named with its hint for the launcher
  // to prompt — and no settings, which the profile keeps for OMP. The one line
  // a plain launch prints names the profile and the website.
  const [launched, secrets, settings, value, team_, handed] = launch(join(repo));
  assert.match(noticed, /^agent-distro profile: using repo \(from .*agent-distro\.nix\) · https:\/\/agent-distro\.nixos\.asia$/m);
  assert.match(launched, /^--plugin-dir \/built-in\/kept --plugin-dir \S+\/agent-distro\/plugins\/sha256-\S+\/claude\/\S+\/out$/);
  assert.equal(secrets, "LITELLM_API_KEY=it's here");
  assert.equal(settings, '', 'settings are the harness\'s own: this one has none');
  assert.equal(value, 'https://gateway.test');
  assert.equal(handed, 'unset', 'the hand-over never reaches the harness');
  // A harness that reads settings gets its own section, and only its own.
  const ompArgs = join(temporary(), 'args.json');
  writeFileSync(ompArgs, JSON.stringify({ harness: 'omp', bash: '/bin/sh', env: '/usr/bin/env', profile: [], info }));
  const run = spawnSync(process.execPath, [join(src, 'plugin/launch-cli.mjs'), ompArgs],
    { cwd: join(repo), encoding: 'utf8', env: { PATH: process.env.PATH, XDG_CACHE_HOME: temporary() } });
  assert.equal(run.status, 0, run.stderr);
  const settingsOf = spawnSync(BASH, ['-euc', `${run.stdout} printf '%s' "$profile_settings"`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(settingsOf.stdout), { modelRoles: { default: 'litellm/large' } });
  // `AGENT_DISTRO_SETTINGS=0`: plugins only — no export, no secret, no settings.
  const [optedLaunched, optedSecrets, optedSettings, optedValue] =
    launch(join(repo), { AGENT_DISTRO_SETTINGS: '0' });
  assert.match(optedLaunched, /^--plugin-dir \/built-in\/kept --plugin-dir /);
  assert.deepEqual([optedSecrets, optedSettings, optedValue], ['', '', '']);
  // Over AI_PROFILE: the built-in plugin, the team's, then the repository's,
  // and the team's environment, which the repository does not replace.
  const [stacked, , , , stackedTeam] = launch(bare, { AI_PROFILE: elsewhere });
  assert.match(noticed, new RegExp(`^agent-distro profile: using bare \\+ elsewhere \\(from \\S+/agent-distro\\.nix over AI_PROFILE=${elsewhere}\\) · `, 'm'));
  const translated = stacked.match(/^--plugin-dir \/built-in\/kept --plugin-dir (\S+\/sha256-\S+\/out) --plugin-dir (\S+\/sha256-\S+\/out)$/);
  assert.ok(translated, stacked);
  // Each translation records the plugin it came from.
  const rootOf = (out: string) => JSON.parse(readFileSync(join(out, '../description.json'), 'utf8')).root;
  assert.deepEqual(translated.slice(1).map(rootOf), [team, bareOwn].map((root) => realpathSync(root)));
  assert.equal(stackedTeam, 'https://team.test');
  // The picker's resolution wins over the repository's, and is used as handed.
  const evaluations = calls('eval');
  const handedOverJson = JSON.stringify({
    ...VANILLA, source: 'positional', origin: 'vanilla', keepsBuiltIn: true, plugins: [], env: {}, settings: {}, paths: [],
  });
  assert.deepEqual(launch(repo, { AGENT_DISTRO_PROFILE: handedOverJson }).slice(0, 3), ['--plugin-dir /built-in/kept', '', '']);
  assert.equal(calls('eval'), evaluations);
});
