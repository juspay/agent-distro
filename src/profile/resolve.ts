/**
 * The profile in effect for one launch.
 *
 * A profile is an `agent-distro.nix` in any git repository, or one built by
 * `agent-distro.lib.mkProfile`: a store path holding
 * `share/agent-distro/profile.json`, its plugins under
 * `share/agent-distro/plugins/<index>/`, and its `packages` in `bin/`. The one
 * in effect is the picker's leading positional selector, exactly; else the
 * stack, bottom to top, of the `agent-distro.nix` found from the working
 * directory up to the git root over every AI_PROFILE entry, each composed over
 * the one beneath (`merge`). A launch with none — `AI_PROFILE` unset or empty,
 * and no repository — has no profile at all, and nothing is added to the
 * harnesses.
 *
 * AI_PROFILE is a stack: whitespace-separated entries composed left to right,
 * later entries winning where they overlap. An entry, like a positional selector, is
 * a reference: a path (absolute, or starting with ./, ../ or ~/) to the file,
 * its directory, or a built profile, or else, containing `/` or `:`, a flake
 * reference such as `github:owner/repo?dir=sub`, fetched with
 * `nix flake prefetch`. An entry that is neither is an error naming it and its
 * position in the stack.
 *
 * Each file is evaluated once per content and agent-distro build by
 * evaluate.nix, and cached under
 * `${XDG_CACHE_HOME:-~/.cache}/agent-distro/profiles/<key>/profile.json`;
 * what no launch has used for STALE_DAYS is removed when something new is
 * cached. Its plugin references and packages are resolved at every launch,
 * since neither is pinned by the file: a reference follows its branch (Nix's
 * tarball TTL bounds the cost), and a package that is gone is fetched again,
 * from the binary cache only, as the updater does.
 *
 * A built profile is read, not evaluated: its `profile.json` names it and
 * carries its `env` and `settings`, its `plugins/<index>/root` symlinks name
 * the plugins, and its `bin/` joins PATH as a launch-time profile's `packages`
 * do. Its `plugins/<index>/description.json` is the reader's own output, so a
 * launch uses it — rather than reading the plugin root again — exactly when
 * its `reader` is this launcher's runtime tree (`runtimeReader`); otherwise
 * the roots are read as any launch-time profile's are.
 *
 * A repository's Nix is untrusted: opening a terminal in a clone evaluates
 * it. Nix evaluates it restricted (no network, no files beyond its own
 * directory, nixpkgs and evaluate.nix) and with only the variables nix itself
 * needs, so it can neither read the user's secrets nor send them anywhere.
 *
 * Each reference's last store path is remembered under
 * `${XDG_CACHE_HOME:-~/.cache}/agent-distro/references/`, so a launch
 * without network uses what is already in the store, and says so.
 *
 * What can keep a launch waiting says so as it starts (src/log.ts `slow`): an
 * evaluation the cache misses, a reference fetched for the first time, a
 * package fetched from the binary cache. Every nix command, and every cache
 * hit or miss, is logged at debug.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isName, SOURCES, type InEffect, type Source } from '../listing.ts';
import { cacheRoot, isStrings, LaunchError, printable, sha256, sweep, writeAtomic } from '../plugin/launch.ts';
import { log, slow, SITE } from '../log.ts';
import { wouldCompile } from '../update/update.ts';
import { isFile, isDirectory, lexists, realpath } from '../util.ts';

export const FILE = 'agent-distro.nix';
/** The variable a profile reference falls back to: a whitespace-separated stack. */
export const VARIABLE = 'AI_PROFILE';

/**
 * The runtime tree this launcher runs from, as a built profile's `reader`
 * names the tree that read its plugins (lib/runtime.nix's, whose name is its
 * store hash). A copy of the runtime elsewhere names itself, so the
 * descriptions it wrote are not taken for this one's.
 */
export const runtimeReader: string = basename(dirname(dirname(import.meta.dirname)));

/** One `env` entry: a value exported before the harness starts, or a secret it prompts for. */
export type EnvValue = string | { secret: true; hint?: string };
/** Environment variables a profile exports, by name. */
export type ProfileEnv = Record<string, EnvValue>;
/** One harness's section of a profile's `settings`; opaque to the resolver. */
export type SettingsSection = Record<string, unknown>;
/** Harness configuration a profile defaults, by harness name. */
export type Settings = Record<string, SettingsSection>;

/** What a launcher knows at build time, from lib/runtime.nix. */
export type Info = {
  /**
   * The nixpkgs `packages` are evaluated against: a locked flake reference,
   * fetched only for a profile with `packages`, or a store path the launcher
   * holds.
   */
  nixpkgs: string;
  /**
   * Where that reference's tree is in the store, which the launcher does not
   * hold: used while it is there, since Nix downloads a locked github:
   * reference again rather than finding it in the store.
   */
  nixpkgsPath?: string;
  /** The system `packages` are evaluated for. */
  system: string;
};

/** Which profile, and from where. */
export type Selection = Pick<InEffect, 'source' | 'origin'> & {
  /** For an AI_PROFILE entry: its position in the stack, 1-based, and the stack's length. */
  entry?: { position: number; count: number };
};

/**
 * A plugin description a built profile already holds, by the plugin's root:
 * `description` is its `description.json` (lib/mk-profile.nix).
 */
export type Described = { root: string; description: string };

/** The profile in effect, resolved for this launch. */
export type Resolved = InEffect & {
  /** Plugin directories. */
  plugins: string[];
  env: ProfileEnv;
  settings: Settings;
  /** Directories of the profile's packages' commands, for PATH. */
  paths: string[];
  /**
   * Descriptions held by a built profile of the stack, used instead of reading
   * those plugins' roots again: only when that profile's `reader` is
   * `runtimeReader`, so the output is this runtime's.
   */
  descriptions?: Described[];
};

/** A cached evaluation of one file: references unresolved, packages unbuilt. */
type Evaluated = {
  name: string;
  description: string;
  plugins: string[];
  env: ProfileEnv;
  settings: Settings;
  /** Attributes this build no longer reads; each is warned about once per launch. */
  deprecated: string[];
  packages: { name: string; drvPath: string; out: string; bin: string }[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
// The launcher reads the value with `${!name}`: only a shell variable name is safe.
const isVariableName = (value: unknown) => isString(value) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

/** The harnesses a profile's `settings` is read for. */
const SETTINGS_HARNESSES: Record<string, true> = { omp: true, opencode: true };

/** Why `value` is not a profile's `env`, or null when it is one. */
function envProblem(value: unknown): string | null {
  if (!isObject(value)) return 'must be an attribute set';
  for (const [name, entry] of Object.entries(value)) {
    if (!isVariableName(name)) return `\`${name}\` is not an environment variable name`;
    if (isString(entry)) continue;
    if (!isObject(entry) || entry.secret !== true
      || Object.keys(entry).some((key) => key !== 'secret' && key !== 'hint')) {
      return `\`${name}\` must be a string, or \`{ secret = true; }\` with an optional \`hint\``;
    }
    if (entry.hint !== undefined && !isString(entry.hint)) return `\`${name}.hint\` must be a string`;
  }
  return null;
}

/** Why `value` is not a profile's `settings`, or null when it is one. */
function settingsProblem(value: unknown): string | null {
  if (!isObject(value)) return 'must be an attribute set';
  for (const [name, section] of Object.entries(value)) {
    if (!Object.hasOwn(SETTINGS_HARNESSES, name)) {
      return `\`${name}\` is not a harness whose configuration a profile sets (${Object.keys(SETTINGS_HARNESSES).join(', ')})`;
    }
    if (!isObject(section)) return `\`${name}\` must be an attribute set`;
  }
  return null;
}

/**
 * Fail on what `value` is not: a profile's `env` and `settings`. `what` names
 * the profile, as its other errors do.
 */
function validate(what: string, value: unknown): asserts value is { env: ProfileEnv; settings: Settings } {
  if (!isObject(value)) throw new LaunchError(`${what}: must be an object`);
  const env = envProblem(value.env);
  if (env) throw new LaunchError(`${what}: \`env\` ${env}`);
  const settings = settingsProblem(value.settings);
  if (settings) throw new LaunchError(`${what}: \`settings\` ${settings}`);
}

function isInEffect(value: unknown): value is InEffect {
  return isObject(value) && isName(value.name) && isString(value.description)
    && SOURCES.includes(value.source as Source) && isString(value.origin)
    && (value.over === undefined || isInEffect(value.over));
}

const isDescriptions = (value: unknown): value is Described[] =>
  Array.isArray(value)
  && value.every((entry) => isObject(entry) && isString(entry.root) && isString(entry.description));

export function isResolved(value: unknown): value is Resolved {
  return isInEffect(value) && isStrings(value.plugins)
    && envProblem(value.env) === null && settingsProblem(value.settings) === null && isStrings(value.paths)
    && (value.descriptions === undefined || isDescriptions(value.descriptions));
}

function isEvaluated(value: unknown): value is Evaluated {
  return isObject(value) && isName(value.name) && isString(value.description) && isStrings(value.plugins)
    && envProblem(value.env) === null && settingsProblem(value.settings) === null && isStrings(value.deprecated)
    && Array.isArray(value.packages)
    && value.packages.every((p) => isObject(p) && isString(p.name) && isString(p.drvPath) && isString(p.out) && isString(p.bin));
}

/**
 * The `agent-distro.nix` nearest `cwd`, at or below the git root that holds
 * it; null outside a git repository or when none is found.
 */
export function discover(cwd: string): string | null {
  let found: string | null = null;
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (found === null && isFile(join(directory, FILE))) found = join(directory, FILE);
    // `.git` is a directory in a clone and a file in a worktree or submodule.
    if (lexists(join(directory, '.git'))) return found;
    if (dirname(directory) === directory) return null;
  }
}

/** The working directory, or undefined when it was removed from under us: in no repository. */
export function workingDirectory(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

/**
 * The entries of an AI_PROFILE stack: whitespace-separated, as nix's own lists
 * are (`substituters`, `trusted-public-keys`). No reference, store path or
 * entry holds whitespace, so splitting needs no other rule — and `:` is left
 * to the references that carry one (`github:owner/repo?dir=sub`).
 */
function entries(value: string): string[] {
  return value.trim().split(/\s+/).filter((entry) => entry !== '');
}

/**
 * The profiles this launch is to use, bottom to top, before anything is read:
 * the positional selector alone, else every AI_PROFILE entry in order and then
 * the repository's, those that are there. `AI_PROFILE=` or unset and no
 * repository is no profile.
 */
export function select(positional: string | undefined, cwd: string | undefined, env: NodeJS.ProcessEnv): Selection[] {
  if (positional) return [{ source: 'positional', origin: positional }];
  const stack: Selection[] = [];
  const variable = entries(env[VARIABLE] ?? '');
  variable.forEach((origin, i) => stack.push({
    source: 'variable', origin, entry: { position: i + 1, count: variable.length },
  }));
  const found = cwd === undefined ? null : discover(cwd);
  if (found) stack.push({ source: 'repository', origin: found });
  return stack;
}

type Kind = { path: string } | { flake: string };

function classify(reference: string, env: NodeJS.ProcessEnv): Kind | null {
  if (reference.startsWith('/')) return { path: reference };
  if (reference === '.' || reference === '..' || reference.startsWith('./') || reference.startsWith('../')) {
    return { path: resolve(reference) };
  }
  if (reference.startsWith('~/') && env.HOME) return { path: join(env.HOME, reference.slice(2)) };
  if (/[/:]/.test(reference)) return { flake: reference };
  return null;
}

/** What a selection names, or null when it names nothing. */
function kindOf(selection: Selection, env: NodeJS.ProcessEnv): Kind | null {
  if (selection.source === 'repository') return { path: selection.origin };
  return classify(selection.origin, env);
}

/** How errors name one profile of the selection: what the user typed, where. */
export function label({ source, origin, entry }: Selection): string {
  if (source === 'variable') {
    return `${VARIABLE}=${origin}${entry ? ` (entry ${entry.position} of ${entry.count})` : ''}`;
  }
  if (source === 'positional') return `profile ${origin}`;
  return origin;
}

const FEATURES = 'extra-experimental-features = nix-command flakes';

/** What nix itself needs from the environment: all an evaluation of a profile sees. */
const NIX_NEEDS = [
  'PATH', 'HOME', 'USER', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_HOME',
  'XDG_STATE_HOME', 'NIX_REMOTE', 'NIX_CONF_DIR', 'NIX_USER_CONF_FILES', 'NIX_STORE_DIR', 'NIX_STATE_DIR',
  'NIX_DAEMON_SOCKET_PATH', 'NIX_SSL_CERT_FILE', 'SSL_CERT_FILE',
];

/**
 * The environment one nix command runs with, the commands the resolver uses
 * enabled whatever the user's configuration says: this process's own, or for
 * an evaluation (`scrubbed`) only what nix needs.
 */
export function nixEnvironment(scrubbed = false): NodeJS.ProcessEnv {
  if (!scrubbed) {
    const config = process.env.NIX_CONFIG;
    return { ...process.env, NIX_CONFIG: config ? `${config}\n${FEATURES}` : FEATURES };
  }
  // Not even the user's NIX_CONFIG, which can carry access tokens.
  const needed = NIX_NEEDS.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]);
  return { ...Object.fromEntries(needed), NIX_CONFIG: FEATURES };
}

/** `value` as a Nix expression: JSON in a Nix string, `$` escaped against interpolation. */
const nixJSON = (value: unknown) => `builtins.fromJSON ${JSON.stringify(JSON.stringify(value)).replaceAll('$', '\\$')}`;

/**
 * Run nix for its stdout; a failure is a LaunchError carrying nix's own
 * message, or, when it printed none, how it exited and its last line of output.
 */
function nix(args: string[], what: string, env: NodeJS.ProcessEnv = nixEnvironment()): string {
  log.profile.debug(`running nix ${args.join(' ')}`);
  const result = spawnSync('nix', args, { encoding: 'utf8', maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'pipe'], env });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new LaunchError(`${what}: ${missing ? 'nix is not on PATH' : result.error.message}`);
  }
  if (result.status === 0) return result.stdout;
  const message = result.stderr.trim();
  if (message) throw new LaunchError(`${what}:\n${message}`);
  const exit = result.signal ? `nix was killed by ${result.signal}` : `nix exited with code ${result.status}`;
  const last = result.stdout.trim().split('\n').pop();
  throw new LaunchError(`${what}: ${exit} and printed no error${last ? `; its last output: ${last}` : ''}`);
}

/**
 * A flake reference's directory in the store: the fetched tree, and its `dir`
 * within it. Nix downloads the global flake registry before fetching any
 * reference, so without network even a git+file: one would fail; only an
 * indirect reference (no `scheme:`, such as `nixpkgs/nixos-unstable`) is
 * looked up in it, so the others skip it.
 */
export function prefetch(reference: string, what: string): string {
  const registry = /^[a-z][a-z0-9+.-]*:/i.test(reference) ? ['--option', 'flake-registry', ''] : [];
  const text = nix(['flake', 'prefetch', ...registry, '--json', reference], `${what}: cannot fetch ${reference}`);
  let storePath: unknown;
  let dir: unknown;
  try {
    const value = JSON.parse(text);
    storePath = value.storePath;
    dir = value.locked?.dir ?? value.original?.dir;
  } catch (error) {
    log.profile.debug(`nix flake prefetch printed unreadable JSON: ${(error as Error).message}`);
    storePath = undefined;
  }
  if (!isString(storePath) || !isAbsolute(storePath)) {
    throw new LaunchError(`${what}: nix flake prefetch gave no store path for ${reference}`);
  }
  return isString(dir) && dir ? join(storePath, dir) : storePath;
}

/** The store path `reference` last fetched to, or '' when there is none. */
function remembered(memory: string): string {
  try {
    return readFileSync(memory, 'utf8').trim();
  } catch (error) {
    // Never fetched: nothing to fall back to.
    log.profile.debug(`no remembered store path at ${memory}: ${(error as Error).message}`);
    return '';
  }
}

/**
 * `prefetch`, remembering the store path under the cache; when nix cannot
 * fetch (say, offline past the tarball TTL), the last one, if still in the
 * store, with a warning. A reference whose last store path is still there is
 * most likely fresh in nix's own cache, so only one that is not says it is
 * being fetched.
 */
function fetched(reference: string, what: string, cache: string): string {
  const memory = join(cache, 'references', sha256(reference));
  const last = remembered(memory);
  const stored = isAbsolute(last) && existsSync(last);
  try {
    const fetch = () => prefetch(reference, what);
    const path = stored ? fetch() : slow(log.profile, `fetching ${reference}`, fetch);
    writeAtomic(memory, path + '\n');
    return path;
  } catch (error) {
    if (!(error instanceof LaunchError)) throw error;
    if (!stored) throw error;
    log.profile.warn(`${what}: cannot fetch ${reference}; using ${last}, from the last launch that could`);
    log.profile.debug(error.message);
    return last;
  }
}

const EVALUATE = join(import.meta.dirname, 'evaluate.nix');

/**
 * Evaluate `file`, without network or the user's environment (restrict-eval
 * also empties getEnv), and reading nothing beyond its directory,
 * evaluate.nix and nixpkgs. --impure is only for reading the checkout in
 * place, outside the store; restrict-eval bounds it. Without nixpkgs, a
 * profile with packages evaluates them to null: only then is nixpkgs fetched
 * and the file evaluated again.
 */
export function evaluate(file: string, info: Info, cache: string, what: string): Evaluated {
  const run = (nixpkgs: string | null): unknown => JSON.parse(nix(['eval', '--json', '--impure',
    '--option', 'restrict-eval', 'true', '--option', 'allowed-uris', '', '--option', 'nix-path', '',
    ...[dirname(file), dirname(EVALUATE), ...(nixpkgs === null ? [] : [nixpkgs])].flatMap((path) => ['-I', path]),
    '--expr', `import ${JSON.stringify(EVALUATE)} (${nixJSON({ file, nixpkgs, system: info.system })})`],
  `${what}: cannot evaluate ${file}`, nixEnvironment(true)));
  let value = run(null);
  if (isObject(value) && value.packages === null) {
    const stored = info.nixpkgsPath && existsSync(info.nixpkgsPath) ? info.nixpkgsPath : undefined;
    value = run(isAbsolute(info.nixpkgs) ? info.nixpkgs : stored ?? fetched(info.nixpkgs, `${what}: nixpkgs for its packages`, cache));
  }
  if (isObject(value)) {
    if (!isName(value.name)) throw new LaunchError(`${what}: ${file}: \`name\` must be one word without /`);
    validate(`${what}: ${file}`, value);
  }
  if (!isEvaluated(value)) throw new LaunchError(`${what}: ${file} is not a profile`);
  return value;
}

/**
 * The cached evaluation of `file`, evaluating it first when absent or when
 * `again`. Keyed by the file's path (its relative paths are relative to it),
 * its contents, and this agent-distro build.
 */
function evaluated(file: string, info: Info, cache: string, what: string, again: boolean): Evaluated {
  const profiles = join(cache, 'profiles');
  const key = sha256(JSON.stringify({
    file, content: sha256(readFileSync(file)), runtime: import.meta.dirname, nixpkgs: info.nixpkgs, system: info.system,
  }));
  const path = join(profiles, key, 'profile.json');
  if (!again && existsSync(path)) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isEvaluated(value)) {
        const now = new Date();
        utimesSync(dirname(path), now, now);
        log.profile.debug(`cache hit: ${path}`);
        return value;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  log.profile.debug(`cache ${again ? 'bypassed' : 'miss'}: ${path}`);
  const value = slow(log.profile, `evaluating ${file}`, () => evaluate(file, info, cache, what));
  writeAtomic(path, JSON.stringify(value, null, 2) + '\n');
  sweep(profiles, (name) => name !== key);
  return value;
}

/** Build the packages not in the store, from the binary cache only; their PATH directories. */
function realise(profile: Evaluated, what: string): string[] {
  for (const { name, drvPath, out } of profile.packages) {
    if (existsSync(out)) continue;
    const target = `${drvPath}^*`;
    // The dry run first: only a package that the cache does have is announced
    // as being fetched.
    const plan = wouldCompile('nix', target, [], nixEnvironment(), log.profile);
    if ('unknown' in plan) {
      throw new LaunchError(`${what}: cannot tell whether package ${name} is in the binary cache (${plan.unknown}); `
        + 'agent-distro never compiles');
    }
    if (plan.names) {
      throw new LaunchError(`${what}: package ${name} is not in the binary cache (would build ${plan.names}); `
        + 'agent-distro never compiles');
    }
    slow(log.profile, `fetching package ${name} from the binary cache`,
      () => nix(['build', '--no-link', target], `${what}: cannot fetch package ${name}`));
  }
  return profile.packages.map((p) => p.bin);
}

/** The profile file a path reference names: the file, or the one in that directory. */
function fileAt(path: string, what: string): string {
  const file = isDirectory(path) ? join(path, FILE) : path;
  if (!isFile(file)) throw new LaunchError(`${what}: no ${FILE} at ${path}`);
  return file;
}

/** A profile built by `agent-distro.lib.mkProfile`, as its store path holds it. */
type Built = {
  /** The store path: its `profile.json`, its plugins and its `bin/`. */
  dir: string;
  name: string;
  description: string;
  env: ProfileEnv;
  settings: Settings;
  /** The runtime tree that read these plugins (lib/mk-profile.nix's `reader`). */
  reader: string;
  plugins: Described[];
};

/**
 * `directory` as a built profile, or null when it holds no
 * `share/agent-distro/profile.json` and is therefore a directory to evaluate.
 */
function builtProfile(directory: string): Built | null {
  const file = join(directory, 'share/agent-distro/profile.json');
  if (!isFile(file)) return null;
  const at = `${directory}: ${file}`;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new LaunchError(`${at} is not valid JSON: ${error.message}`);
  }
  if (!isObject(value)) throw new LaunchError(`${at} must hold an object`);
  const name = value.name;
  const reader = value.reader;
  if (!isName(name)) throw new LaunchError(`${at}: \`name\` must be one word without /`);
  if (!isString(reader) || reader === '') throw new LaunchError(`${at}: \`reader\` must be a nonempty string`);
  validate(at, value);
  const base = join(directory, 'share/agent-distro/plugins');
  let indexes: string[];
  try {
    indexes = readdirSync(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    indexes = [];
  }
  const plugins = indexes.sort((a, b) => Number(a) - Number(b)).map((index) => {
    // One plugin: the reader's own output for it, and `root` — a symlink to
    // the plugin's store path at build time, whose target is the root now.
    const at = join(base, index);
    const root = join(at, 'root');
    const description = join(at, 'description.json');
    if (!lexists(root)) throw new LaunchError(`${at}: no root`);
    if (!isFile(description)) throw new LaunchError(`${at}: no description.json`);
    return { root: realpath(root), description };
  });
  return {
    dir: directory, name, reader, plugins,
    description: isString(value.description) ? value.description : '',
    env: value.env, settings: value.settings,
  };
}

/**
 * `upper` composed over `lower`: plugins and packages are both, lower's first;
 * `env` and `settings` are key-wise, upper's winning; the rest is upper's,
 * `over` naming lower unless it is the launcher's built-in default. Only the
 * repository's is ever over another named profile, so `lower` names none
 * beneath it.
 */
function merge(lower: Resolved, upper: Resolved): Resolved {
  const { name, description, source, origin, over } = lower;
  const descriptions = [...(lower.descriptions ?? []), ...(upper.descriptions ?? [])];
  return {
    name: upper.name, description: upper.description, source: upper.source, origin: upper.origin,
    // The whole chain beneath, so a stack of three names all three.
    over: { name, description, source, origin, ...(over ? { over } : {}) },
    plugins: [...lower.plugins, ...upper.plugins],
    env: { ...lower.env, ...upper.env }, settings: { ...lower.settings, ...upper.settings },
    paths: [...lower.paths, ...upper.paths],
    ...(descriptions.length ? { descriptions } : {}),
  };
}

/** The profile in effect: each of `stack` (from `select`) resolved, and composed bottom to top; null when there is none. */
export function resolveProfile(info: Info, stack: Selection[], env: NodeJS.ProcessEnv): Resolved | null {
  const resolved = stack.map((selection) => resolveOne(info, selection, env));
  return resolved.length ? resolved.reduce(merge) : null;
}

function resolveOne(info: Info, selection: Selection, env: NodeJS.ProcessEnv): Resolved {
  const what = printable(label(selection));
  const kind = kindOf(selection, env);
  if (kind === null) {
    throw new LaunchError(`${what}: not a reference: a path starting with /, ./ or ../, or a flake `
      + 'reference such as github:owner/repo');
  }
  const { source, origin } = selection;
  // A built profile is read where it lies; a repository's is evaluated.
  const built = 'path' in kind ? builtProfile(kind.path) : null;
  if (built) {
    const matching = built.reader === runtimeReader;
    // Its `bin/` — the profile's `packages` — goes first on PATH, as a
    // launch-time profile's do.
    const bin = join(built.dir, 'bin');
    return {
      name: built.name, description: built.description, source, origin,
      plugins: built.plugins.map((plugin) => plugin.root), env: built.env, settings: built.settings,
      paths: isDirectory(bin) ? [bin] : [],
      ...(matching ? { descriptions: built.plugins } : {}),
    };
  }
  const cache = cacheRoot(env, what);
  const file = fileAt('path' in kind ? kind.path : fetched(kind.flake, what, cache), what);
  let profile = evaluated(file, info, cache, what, false);
  // A package's derivation can be collected with its output; evaluate afresh to get it back.
  if (profile.packages.some((p) => !existsSync(p.out) && !existsSync(p.drvPath))) {
    profile = evaluated(file, info, cache, what, true);
  }
  for (const name of profile.deprecated) {
    // The evaluation is cached per content, so this is what keeps the warning
    // in front of a profile written for an older agent-distro.
    log.profile.warn(`\`${name}\` is no longer read; see ${SITE}/#profiles`);
  }
  const paths = realise(profile, what);
  const plugins = profile.plugins.map((entry) => (entry.startsWith('/') ? entry : fetched(entry, what, cache)));
  return {
    name: profile.name, description: profile.description, source, origin,
    plugins, env: profile.env, settings: profile.settings, paths,
  };
}
