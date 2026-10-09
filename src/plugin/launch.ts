/**
 * Set up one launch: the profile in effect (src/profile/resolve.ts), and the
 * Agent Plugins named by AGENT_DISTRO_PLUGINS on top of it.
 *
 * Run through launch-cli.mjs, as `node launch-cli.mjs ARGS_JSON`, by
 * every harness launcher before it starts its harness.
 *
 * ARGS_JSON is written by a harness launcher at build time: `harness` names the
 * adapter (`src/harness/<harness>.ts`, which exports `adapter`), `profile` lists
 * the built-in profile's plugins as `{ description, ... }` entries, `info`
 * describes that profile (src/profile/resolve.ts), and the rest is
 * the adapter's own. Stdout is shell for the launcher to `eval`: `launched` is
 * what the adapter prints (extra arguments as shell words, or a path),
 * `profile_gateway` the gateway in effect as JSON (empty for none) with its
 * `_url`, `_key_env` and `_key_hint`, and the profile's packages go first on
 * PATH.
 *
 * A profile other than the built-in one replaces the built-in's plugins, its
 * gateway and its packages: its plugin directories are translated exactly as
 * the variable's, ahead of them. Each directory is read exactly as a built-in
 * plugin is, then translated once per content into
 * `${XDG_CACHE_HOME:-~/.cache}/agent-distro/plugins/<key>/<harness>/<translator>`.
 * The key is the plugin's own path when it is under /nix/store, which is
 * already content-addressed; otherwise it hashes the directory's NAR
 * serialization together with its path, since translations embed the root.
 * `<translator>` names the runtime and the adapter's inputs, so a new
 * agent-distro never reads an older translation.
 *
 * Every use stamps a translation's link; a launch that translates something
 * new also removes what no launch has used for STALE_DAYS, so the cache holds
 * what is in use rather than every version ever seen.
 *
 * Plugins are matched by manifest name, never by version: a plugin on the
 * variable replaces the profile's plugin of the same name, and on the variable
 * the last of a name wins.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, lutimesSync, mkdirSync, openSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Fatal, isDescription, readPlugin, type Description } from './read.ts';
import { readDescription } from './resources.ts';
import { isSystemError, realpath, writeTemporary } from '../util.ts';
import type { Gateway } from '../gateway/models.ts';
import { resolveProfile, select, workingDirectory, isResolved, type Info, type Resolved } from '../profile/resolve.ts';

export type Report = (message: string) => void;

/** A profile plugin, as the launcher's ARGS_JSON lists it. */
export type ProfileEntry = { description: string; [key: string]: unknown };

export type ProfilePlugin<E extends ProfileEntry = ProfileEntry> = {
  name: string;
  description: Description;
  entry: E;
};

/** A plugin from the variable, translated for one harness. */
export type LaunchPlugin = {
  name: string;
  key: string;
  description: Description;
  /** The adapter's cached translation; never written to after it is returned. */
  translation: string;
};

export type Launch<A, E extends ProfileEntry> = {
  args: A;
  /** The profile's plugins that stay, in profile order. */
  kept: ProfilePlugin<E>[];
  /** The profile's plugins a plugin on the variable replaces. */
  replaced: ProfilePlugin<E>[];
  /** The variable's plugins, deduplicated, in order; empty when it names none. */
  plugins: LaunchPlugin[];
  /** `${XDG_CACHE_HOME:-~/.cache}/agent-distro`; null when `plugins` and `replaced` are empty. */
  cache: string | null;
  report: Report;
};

export interface Adapter<A = any, E extends ProfileEntry = ProfileEntry, I = unknown> {
  /** Everything besides the plugin that shapes `translate`'s output. */
  translationInputs(args: A): I;
  /**
   * Write one plugin's translation into the empty directory `out`. It sees
   * only `translationInputs`, which name the cached translation.
   */
  translate(description: Description, out: string, inputs: I, report: Report, key: string): void;
  /**
   * What the launcher reads from stdout. With no plugins, the launch is the
   * profile's own and needs no cache.
   */
  launch(launch: Launch<A, E>): string;
}

/** A launch the variable cannot serve; the message names what is wrong. */
export class LaunchError extends Error {}

export const VARIABLE = 'AGENT_DISTRO_PLUGINS';

/** Unused this long, a translation or a launch file may be removed. */
export const STALE_DAYS = 14;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

/**
 * `${XDG_CACHE_HOME:-$HOME/.cache}/agent-distro`. A relative directory is an
 * error, not a cache under whatever directory the harness starts in:
 * translations embed their own paths.
 */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env, label = VARIABLE): string {
  const [name, base] = env.XDG_CACHE_HOME ? ['XDG_CACHE_HOME', env.XDG_CACHE_HOME]
    : env.HOME ? ['HOME', join(env.HOME, '.cache')] : [null, null];
  if (name === null) throw new LaunchError(`${label}: cannot cache translations: XDG_CACHE_HOME and HOME are unset`);
  if (!isAbsolute(base!)) throw new LaunchError(`${label}: ${name} must be an absolute path, not ${JSON.stringify(env[name])}`);
  return join(base!, 'agent-distro');
}

/** The variable's entries in order; empty components are ignored. */
export function entries(value: string | undefined): string[] {
  return (value ?? '').split(':').filter((entry) => entry !== '');
}

/** Control characters escaped, so cached or plugin-chosen text cannot drive the terminal. */
export function printable(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu,
    (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function narString(hash: ReturnType<typeof createHash>, value: string | Buffer) {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
  if (bytes.length % 8) hash.update(Buffer.alloc(8 - (bytes.length % 8)));
}

const SLASH = Buffer.from('/');
const GIT = Buffer.from('.git');

/** One NAR node. Paths stay bytes, so a name that is not UTF-8 is hashed, not mangled. */
function narNode(hash: ReturnType<typeof createHash>, path: Buffer, skip: Buffer | null) {
  const put = (...values: (string | Buffer)[]) => values.forEach((value) => narString(hash, value));
  put('(', 'type');
  // Open first and ask the open file what it is, so nothing read can differ
  // from what was checked. O_NOFOLLOW refuses a symlink, which is then read
  // as one; O_NONBLOCK keeps a FIFO from blocking the launch.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ELOOP') throw error;
    put('symlink', 'target', readlinkSync(path, { encoding: 'buffer' }), ')');
    return;
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isFile()) {
      put('regular');
      if (stat.mode & 0o100) put('executable', '');
      put('contents', readFileSync(fd));
    } else if (stat.isDirectory()) {
      put('directory');
      const names = readdirSync(path, { encoding: 'buffer' }).sort(Buffer.compare);
      for (const name of names) {
        if (skip && name.equals(skip)) continue;
        put('entry', '(', 'name', name, 'node');
        narNode(hash, Buffer.concat([path, SLASH, name]), null);
        put(')');
      }
    } else {
      throw new LaunchError(`${VARIABLE}: ${printable(path.toString())} is not a regular file, directory or `
        + 'symlink, so the plugin cannot be hashed');
    }
  } finally {
    closeSync(fd);
  }
  put(')');
}

/**
 * SHA-256 of the directory's NAR serialization, as `nix-hash --type sha256`
 * prints it. `skipGit` leaves out a top-level `.git`, which no translation
 * reads.
 */
export function narHash(path: string, { skipGit = false } = {}): string {
  const hash = createHash('sha256');
  narString(hash, 'nix-archive-1');
  narNode(hash, Buffer.from(path), skipGit ? GIT : null);
  return hash.digest('hex');
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// Only the default store: a plugin in a store elsewhere is keyed by its
// contents, like any other directory.
const STORE = '/nix/store/';
// The longest file name most filesystems allow.
const NAME_MAX = 255;

/**
 * The cache key of a resolved plugin root: one file name, injectively. A
 * store path is used as is, percent-encoded; when that is too long for a file
 * name, its store path's own name stays and the rest is a hash of the path
 * (never of the contents). Any other directory is a hash of its contents,
 * less a top-level `.git`, and of its path.
 */
export function cacheKey(root: string): string {
  if (root.startsWith(STORE) && root.length > STORE.length) {
    const relative = root.slice(STORE.length);
    const key = 'store-' + encodeURIComponent(relative);
    if (Buffer.byteLength(key) <= NAME_MAX) return key;
    // `#` is one character encodeURIComponent always escapes, so this form
    // cannot be the encoding of any path.
    return 'store-' + encodeURIComponent(relative.split('/')[0]).slice(0, 120) + '#' + sha256(relative);
  }
  return 'sha256-' + sha256(`agent-distro plugin\0${root}\0${narHash(root, { skipGit: true })}`);
}

/** Return the translation `link` names, or null when there is none to use. */
function cached(link: string): string | null {
  let target: string;
  try {
    target = readlinkSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const directory = join(dirname(link), target);
  try {
    if (statSync(directory).isDirectory()) return directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // The directory was removed by hand; translate again.
  rmSync(link, { force: true });
  return null;
}

/**
 * A JSON file from the cache, checked with `valid`. Anything else names the
 * directory to remove, rather than failing somewhere later.
 */
export function readCached<T>(path: string, valid: (value: unknown) => value is T, clear = dirname(path)): T {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (valid(value)) return value;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !isSystemError(error)) throw error;
  }
  throw new LaunchError(`${VARIABLE}: the cached ${path} is unreadable or corrupt; remove ${clear} and launch again`);
}

export const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Record a use: the link's own time is when it was last used. */
function stamp(link: string) {
  const now = new Date();
  lutimesSync(link, now, now);
}

/** The names in `directory`, or none when another launch removed it first. */
function listing(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export const stale = (path: string, now: number) => {
  try {
    return now - lstatSync(path).mtimeMs > STALE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

/**
 * Remove the translations no launch has used for STALE_DAYS, directories no
 * link names (a launch interrupted before publishing) once as old, and the
 * key directories left empty. Run when a launch adds a translation, so the
 * cache is bounded by what is in use.
 */
export function prune(cache: string, now = Date.now()) {
  const plugins = join(cache, 'plugins');
  for (const key of listing(plugins)) {
    for (const harness of listing(join(plugins, key))) {
      const directory = join(plugins, key, harness);
      const names = listing(directory);
      const linked = new Set<string>();
      for (const name of names) {
        const path = join(directory, name);
        if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
        const target = readlinkSync(path);
        if (stale(path, now)) {
          rmSync(path, { force: true });
          rmSync(join(directory, target), { recursive: true, force: true });
        } else {
          linked.add(target);
        }
      }
      for (const name of names) {
        const path = join(directory, name);
        if (!linked.has(name) && lstatSync(path, { throwIfNoEntry: false })?.isDirectory() && stale(path, now)) {
          rmSync(path, { recursive: true, force: true });
        }
      }
      removeIfEmpty(directory);
    }
    removeIfEmpty(join(plugins, key));
  }
}

function removeIfEmpty(directory: string) {
  try {
    rmdirSync(directory);
  } catch (error) {
    if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code!)) throw error;
  }
}

/**
 * The cached translation of the plugin at `entry` for one adapter, writing it
 * first when absent. Reports are replayed from the cache, so a cached launch
 * says what the first one did.
 */
export function translate(
  entry: string, harness: string, adapter: Adapter, args: unknown, cache: string, report: Report, label = VARIABLE,
): LaunchPlugin {
  const root = realpath(entry);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new LaunchError(`${label}: ${entry}: ${(error as Error).message}`);
    isDirectory = false;
  }
  if (!isDirectory) throw new LaunchError(`${label}: ${entry} is not a directory`);
  const inputs = adapter.translationInputs(args);
  const translator = sha256(JSON.stringify({ runtime: import.meta.dirname, inputs })).slice(0, 32);
  const replay = (key: string, link: string, directory: string): LaunchPlugin => {
    stamp(link);
    const clear = dirname(link);
    const reports = readCached(join(directory, 'reports.json'), isStrings, clear);
    const description = readCached(join(directory, 'description.json'), isDescription, clear);
    for (const message of reports) report(`${entry}: ${message}`);
    return { name: description.manifest.name, key, description, translation: join(directory, 'out') };
  };

  // A checkout can change while it is read; it is hashed again afterwards,
  // and a translation whose source changed under it is never published.
  for (let attempt = 1; ; attempt++) {
    const key = cacheKey(root);
    const parent = join(cache, 'plugins', key, harness);
    const link = join(parent, translator);
    const existing = cached(link);
    if (existing) return replay(key, link, existing);

    const reports: string[] = [];
    let description: Description;
    try {
      description = readPlugin(root, (message) => reports.push(message));
    } catch (error) {
      if (error instanceof Fatal) throw new LaunchError(`${label}: ${entry}: invalid Agent Plugin: ${error.message}`);
      throw error;
    }
    mkdirSync(parent, { recursive: true });
    // A directory that never moves, since translations embed their own paths;
    // the link to it appears atomically once it is complete.
    const name = `${translator}.${randomBytes(6).toString('hex')}`;
    const directory = join(parent, name);
    try {
      mkdirSync(join(directory, 'out'), { recursive: true });
      writeFileSync(join(directory, 'description.json'), JSON.stringify(description, null, 2));
      adapter.translate(description, join(directory, 'out'), inputs, (message) => reports.push(message), key);
      writeFileSync(join(directory, 'reports.json'), JSON.stringify(reports));
      if (cacheKey(root) !== key) {
        rmSync(directory, { recursive: true, force: true });
        if (attempt === 3) throw new LaunchError(`${label}: ${entry} kept changing while it was translated`);
        continue;
      }
      symlinkSync(name, link);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      // A concurrent launch finished the same translation first.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const winner = cached(link);
        if (winner) return replay(key, link, winner);
      }
      throw error;
    }
    prune(cache);
    return replay(key, link, directory);
  }
}

/** Write `data` at `path` atomically; for content-addressed files. */
export function writeAtomic(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = writeTemporary(dirname(path), '.launch-', data);
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * A JSON document stored under `directory` by the hash of its contents. An
 * existing one is stamped as used; writing a new one removes the others no
 * launch has used for STALE_DAYS.
 */
export function writeAddressed(directory: string, data: unknown): string {
  const text = JSON.stringify(data, null, 2) + '\n';
  const path = join(directory, sha256(text) + '.json');
  try {
    const now = new Date();
    utimesSync(path, now, now);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeAtomic(path, text);
  sweep(directory, (name) => name.endsWith('.json'));
  return path;
}

/** Remove the entries of `directory` matching `which` that no launch has used for STALE_DAYS. */
export function sweep(directory: string, which: (name: string) => boolean = () => true, now = Date.now()) {
  for (const name of listing(directory)) {
    if (which(name) && stale(join(directory, name), now)) rmSync(join(directory, name), { recursive: true, force: true });
  }
}

/**
 * Resolve the variable against the profile: who stays, who is replaced, who
 * is added. `replacement`, the plugin directories of a profile other than the
 * built-in one, replaces every built-in plugin and comes before the variable's.
 */
export function resolve<A extends { profile: E[] }, E extends ProfileEntry>(
  harness: string, adapter: Adapter<A, E>, args: A, value: string | undefined, env: NodeJS.ProcessEnv, report: Report,
  replacement?: string[],
): Launch<A, E> {
  const own = replacement ?? [];
  const names = [...own, ...entries(value)];
  // Nothing to load or take away needs no cache, so it cannot fail for want of one.
  const changes = names.length > 0 || (replacement !== undefined && args.profile.length > 0);
  const cache = changes ? cacheRoot(env, replacement !== undefined ? 'profile' : VARIABLE) : null;
  const byName = new Map<string, LaunchPlugin>();
  for (const [i, entry] of names.entries()) {
    const plugin = translate(entry, harness, adapter, args, cache!, report, i < own.length ? 'profile' : VARIABLE);
    // The last of a name wins, in its own position.
    byName.delete(plugin.name);
    byName.set(plugin.name, plugin);
  }
  const profile = args.profile.map((entry) => {
    const description = readDescription(entry.description);
    return { name: description.manifest.name, description, entry };
  });
  const replaces = (plugin: ProfilePlugin<E>) => replacement !== undefined || byName.has(plugin.name);
  return {
    args, cache, report,
    kept: profile.filter((plugin) => !replaces(plugin)),
    replaced: profile.filter(replaces),
    plugins: [...byName.values()],
  };
}

/** One POSIX shell word, always quoted. */
const quote = (value: string) => "'" + value.replace(/'/g, `'"'"'`) + "'";

/**
 * The profile in effect: the one the picker resolved, handed over in
 * AGENT_DISTRO_PROFILE, else this launch's own resolution.
 */
function profileInEffect(info: Info, env: NodeJS.ProcessEnv): Resolved {
  const handed = env.AGENT_DISTRO_PROFILE;
  if (handed) {
    let value: unknown;
    try {
      value = JSON.parse(handed);
    } catch {
      value = undefined;
    }
    if (!isResolved(value)) throw new LaunchError('AGENT_DISTRO_PROFILE is not a resolved profile; unset it');
    return value;
  }
  return resolveProfile(info, select(undefined, workingDirectory(), env, info), env);
}

/** The shell a launcher evaluates; see the head of this file. */
export function shell(launched: string, gateway: Gateway | null, paths: string[]): string {
  const lines = [
    `launched=${quote(launched)}`,
    'unset AGENT_DISTRO_PROFILE',
    `profile_gateway=${quote(gateway ? JSON.stringify(gateway) : '')}`,
    `profile_gateway_url=${quote(gateway?.url ?? '')}`,
    `profile_gateway_key_env=${quote(gateway?.keyEnv ?? '')}`,
    `profile_gateway_key_hint=${quote(gateway?.keyHint ?? '')}`,
  ];
  if (paths.length) lines.push(`PATH=${quote(paths.join(':'))}"\${PATH:+:$PATH}"`, 'export PATH');
  return lines.join('\n') + '\n';
}

export async function main(argsPath: string): Promise<number> {
  const args = JSON.parse(readFileSync(argsPath, 'utf8'));
  const report: Report = (message) => process.stderr.write(printable(message) + '\n');
  try {
    const { adapter } = await import(`../harness/${args.harness}.ts`) as { adapter: Adapter };
    const profile = profileInEffect(args.info, process.env);
    // The built-in profile is the one this launcher was built with.
    const builtIn = profile.builtin && profile.name === args.info.default;
    const launch = resolve(args.harness, adapter, args, process.env[VARIABLE], process.env, report,
      builtIn ? undefined : profile.plugins);
    process.stdout.write(shell(adapter.launch(launch), profile.gateway, profile.paths));
  } catch (error) {
    if (!(error instanceof LaunchError) && !isSystemError(error)) throw error;
    // A cache that cannot be written fails the launch: there is no degraded mode.
    process.stderr.write(`agent-distro: ${printable((error as Error).message)}\n`);
    return 1;
  }
  return 0;
}
