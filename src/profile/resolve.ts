/**
 * The profile in effect for one launch.
 *
 * A profile is an `agent-distro.nix` in any git repository. The one in effect
 * is, first to last: the picker's leading positional selector, the
 * `agent-distro.nix` found from the working directory up to the git root,
 * AI_PROFILE, and the launcher's built-in default. A selector or AI_PROFILE is
 * a built-in name (`vanilla`, or the launcher's own) or a reference: a path
 * (absolute, or starting with ./, ../ or ~/) to the file or its directory, or
 * else, containing `/` or `:`, a flake reference such as
 * `github:owner/repo?dir=sub`, fetched with `nix flake prefetch`.
 *
 * The file is evaluated once per content and agent-distro build by
 * evaluate.nix, and cached under
 * `${XDG_CACHE_HOME:-~/.cache}/agent-distro/profiles/<key>/profile.json`;
 * what no launch has used for STALE_DAYS is removed when something new is
 * cached. Its plugin references and packages are resolved at every launch,
 * since neither is pinned by the file: a reference follows its branch (Nix's
 * tarball TTL bounds the cost), and a package that is gone is fetched again,
 * from the binary cache only, as the updater does.
 *
 * A repository's Nix is untrusted: opening a terminal in a clone evaluates
 * it. Nix evaluates it restricted (no network, no files beyond its own
 * directory, nixpkgs and evaluate.nix) and with only the variables nix itself
 * needs, so it can neither read the user's secrets nor send them anywhere.
 *
 * Each reference's last store path is remembered under
 * `${XDG_CACHE_HOME:-~/.cache}/agent-distro/references/`, so a launch
 * without network uses what is already in the store, and says so.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, utimesSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Gateway } from '../gateway/models.ts';
import { isName, SOURCES, type InEffect, type Source } from '../listing.ts';
import { cacheRoot, isStrings, LaunchError, printable, sha256, sweep, writeAtomic } from '../plugin/launch.ts';
import { wouldCompile } from '../update/update.ts';
import { isFile, isDirectory, lexists } from '../util.ts';

export const FILE = 'agent-distro.nix';
/** The variable a profile reference falls back to. */
export const VARIABLE = 'AI_PROFILE';

/** A profile built into the launcher. */
export type Builtin = { name: string; description: string; gateway: Gateway | null };

/** What a launcher knows at build time, from lib/runtime.nix. */
export type Info = {
  /** The launcher's own profile: the one in effect when nothing chooses another. */
  default: string;
  builtins: Builtin[];
  /**
   * The nixpkgs `packages` are evaluated against: a locked flake reference,
   * fetched only for a profile with `packages`, or a store path the launcher
   * holds.
   */
  nixpkgs: string;
  /** The system `packages` are evaluated for. */
  system: string;
};

/** Which profile, and from where. */
export type Selection = Pick<InEffect, 'source' | 'origin'>;

/** The profile in effect, resolved for this launch. */
export type Resolved = InEffect & {
  /** Built into the launcher, so its plugins and packages are the launcher's own. */
  builtin: boolean;
  /** Plugin directories. */
  plugins: string[];
  gateway: Gateway | null;
  /** Directories of the profile's packages' commands, for PATH. */
  paths: string[];
};

/** A cached evaluation of one file: references unresolved, packages unbuilt. */
type Evaluated = {
  name: string;
  description: string;
  plugins: string[];
  gateway: Gateway | null;
  packages: { name: string; drvPath: string; out: string; bin: string }[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
// The launcher reads the key with `${!name}`: only a shell variable name is safe.
const isVariableName = (value: unknown) => isString(value) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

/** Why `value` is not a gateway, or null when it is one. */
function gatewayProblem(value: unknown): string | null {
  if (value === null) return null;
  if (!isObject(value)) return 'must be null or an attribute set';
  if (!isString(value.url)) return '`url` must be a string';
  if (!isVariableName(value.keyEnv)) return '`keyEnv` must be an environment variable name';
  if (!isObject(value.models) || !isString(value.models.large) || !isString(value.models.small)) {
    return '`models` must name a `large` and a `small` model';
  }
  if (value.keyHint !== undefined && !isString(value.keyHint)) return '`keyHint` must be a string';
  return null;
}

export function isResolved(value: unknown): value is Resolved {
  return isObject(value) && isName(value.name) && isString(value.description)
    && SOURCES.includes(value.source as Source) && isString(value.origin) && typeof value.builtin === 'boolean'
    && isStrings(value.plugins) && gatewayProblem(value.gateway) === null && isStrings(value.paths);
}

function isEvaluated(value: unknown): value is Evaluated {
  return isObject(value) && isName(value.name) && isString(value.description) && isStrings(value.plugins)
    && gatewayProblem(value.gateway) === null && Array.isArray(value.packages)
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

/** Which profile this launch is to use, before anything is read. */
export function select(positional: string | undefined, cwd: string | undefined, env: NodeJS.ProcessEnv, info: Info): Selection {
  if (positional) return { source: 'positional', origin: positional };
  const found = cwd === undefined ? null : discover(cwd);
  if (found) return { source: 'repository', origin: found };
  if (env[VARIABLE]) return { source: 'variable', origin: env[VARIABLE] };
  return { source: 'builtin', origin: info.default };
}

type Kind = { builtin: Builtin } | { path: string } | { flake: string };

function classify(reference: string, info: Info, env: NodeJS.ProcessEnv): Kind | null {
  const builtin = info.builtins.find((b) => b.name === reference);
  if (builtin) return { builtin };
  if (reference.startsWith('/')) return { path: reference };
  if (reference === '.' || reference === '..' || reference.startsWith('./') || reference.startsWith('../')) {
    return { path: resolve(reference) };
  }
  if (reference.startsWith('~/') && env.HOME) return { path: join(env.HOME, reference.slice(2)) };
  if (/[/:]/.test(reference)) return { flake: reference };
  return null;
}

/** How errors name the selection: what the user typed, where. */
export function label({ source, origin }: Selection): string {
  if (source === 'variable') return `${VARIABLE}=${origin}`;
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
function nixEnvironment(scrubbed = false): NodeJS.ProcessEnv {
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

/** A flake reference's directory in the store: the fetched tree, and its `dir` within it. */
export function prefetch(reference: string, what: string): string {
  const text = nix(['flake', 'prefetch', '--json', reference], `${what}: cannot fetch ${reference}`);
  let storePath: unknown;
  let dir: unknown;
  try {
    const value = JSON.parse(text);
    storePath = value.storePath;
    dir = value.locked?.dir ?? value.original?.dir;
  } catch {
    storePath = undefined;
  }
  if (!isString(storePath) || !isAbsolute(storePath)) {
    throw new LaunchError(`${what}: nix flake prefetch gave no store path for ${reference}`);
  }
  return isString(dir) && dir ? join(storePath, dir) : storePath;
}

/**
 * `prefetch`, remembering the store path under the cache; when nix cannot
 * fetch (say, offline past the tarball TTL), the last one, if still in the
 * store, noted on stderr.
 */
function fetched(reference: string, what: string, cache: string): string {
  const memory = join(cache, 'references', sha256(reference));
  try {
    const path = prefetch(reference, what);
    writeAtomic(memory, path + '\n');
    return path;
  } catch (error) {
    if (!(error instanceof LaunchError)) throw error;
    let last = '';
    try {
      last = readFileSync(memory, 'utf8').trim();
    } catch {
      // Never fetched: nothing to fall back to.
    }
    if (!isAbsolute(last) || !existsSync(last)) throw error;
    process.stderr.write(`agent-distro: ${what}: cannot fetch ${printable(reference)}; using ${last}, from the last launch that could\n`);
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
function evaluate(file: string, info: Info, cache: string, what: string): Evaluated {
  const run = (nixpkgs: string | null): unknown => JSON.parse(nix(['eval', '--json', '--impure',
    '--option', 'restrict-eval', 'true', '--option', 'allowed-uris', '', '--option', 'nix-path', '',
    ...[dirname(file), dirname(EVALUATE), ...(nixpkgs === null ? [] : [nixpkgs])].flatMap((path) => ['-I', path]),
    '--expr', `import ${JSON.stringify(EVALUATE)} (${nixJSON({ file, nixpkgs, system: info.system })})`],
  `${what}: cannot evaluate ${file}`, nixEnvironment(true)));
  let value = run(null);
  if (isObject(value) && value.packages === null) {
    value = run(isAbsolute(info.nixpkgs) ? info.nixpkgs : fetched(info.nixpkgs, `${what}: nixpkgs for its packages`, cache));
  }
  if (isObject(value)) {
    if (!isName(value.name)) throw new LaunchError(`${what}: ${file}: \`name\` must be one word without /`);
    const problem = gatewayProblem(value.gateway);
    if (problem) throw new LaunchError(`${what}: ${file}: \`gateway\` ${problem}`);
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
        return value;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  const value = evaluate(file, info, cache, what);
  writeAtomic(path, JSON.stringify(value, null, 2) + '\n');
  sweep(profiles, (name) => name !== key);
  return value;
}

/** Build the packages not in the store, from the binary cache only; their PATH directories. */
function realise(profile: Evaluated, what: string): string[] {
  for (const { name, drvPath, out } of profile.packages) {
    if (existsSync(out)) continue;
    const target = `${drvPath}^*`;
    const plan = wouldCompile('nix', target, [], nixEnvironment());
    if ('unknown' in plan) {
      throw new LaunchError(`${what}: cannot tell whether package ${name} is in the binary cache (${plan.unknown}); `
        + 'agent-distro never compiles');
    }
    if (plan.names) {
      throw new LaunchError(`${what}: package ${name} is not in the binary cache (would build ${plan.names}); `
        + 'agent-distro never compiles');
    }
    nix(['build', '--no-link', target], `${what}: cannot fetch package ${name}`);
  }
  return profile.packages.map((p) => p.bin);
}

/** The profile file a path reference names: the file, or the one in that directory. */
function fileAt(path: string, what: string): string {
  const file = isDirectory(path) ? join(path, FILE) : path;
  if (!isFile(file)) throw new LaunchError(`${what}: no ${FILE} at ${path}`);
  return file;
}

export function resolveProfile(info: Info, selection: Selection, env: NodeJS.ProcessEnv): Resolved {
  const what = printable(label(selection));
  const kind = selection.source === 'repository' ? { path: selection.origin } : classify(selection.origin, info, env);
  if (kind === null) {
    throw new LaunchError(`${what}: not a built-in profile (${info.builtins.map((b) => b.name).join(', ')}) or a `
      + 'reference: a path starting with /, ./ or ../, or a flake reference such as github:owner/repo');
  }
  const { source, origin } = selection;
  if ('builtin' in kind) return { ...kind.builtin, source, origin, builtin: true, plugins: [], paths: [] };
  const cache = cacheRoot(env, what);
  const file = fileAt('path' in kind ? kind.path : fetched(kind.flake, what, cache), what);
  let profile = evaluated(file, info, cache, what, false);
  // A package's derivation can be collected with its output; evaluate afresh to get it back.
  if (profile.packages.some((p) => !existsSync(p.out) && !existsSync(p.drvPath))) {
    profile = evaluated(file, info, cache, what, true);
  }
  const paths = realise(profile, what);
  const plugins = profile.plugins.map((entry) => (entry.startsWith('/') ? entry : fetched(entry, what, cache)));
  return {
    name: profile.name, description: profile.description, source, origin,
    builtin: false, plugins, gateway: profile.gateway, paths,
  };
}
