/**
 * Set up one launch: the profile in effect (src/profile/resolve.ts), and the
 * Agent Plugins named by AGENT_DISTRO_PLUGINS on top of it.
 *
 * Run through launch-cli.mjs, as `node launch-cli.mjs ARGS_JSON`, by
 * every harness launcher before it starts its harness.
 *
 * ARGS_JSON is written by a harness launcher at build time: `harness` names the
 * adapter (`src/harness/<harness>.ts`, which exports `adapter`), `nixpkgs` and
 * `system` are what it knows of the build — the `Info` a profile's `packages`
 * are evaluated against (src/profile/resolve.ts) — and the rest is the
 * adapter's own. Stdout is shell for the launcher to `eval`: `launched` is
 * what the adapter prints (extra arguments as shell words, or a path),
 * `profile_env_secrets` names each `secret` variable of the profile's `env`
 * with its hint, as `NAME=hint`, for the launcher to prompt for, every other
 * one is exported here, `profile_settings` is the profile's settings for this
 * harness as JSON (empty for none), and the profile's packages go first on
 * PATH. `AGENT_DISTRO_SETTINGS=0` leaves all three empty: plugins only.
 *
 * Every entry of AI_PROFILE composes over the one before it, left to right; the
 * launcher's own profile is the base of that stack — the one beneath the first
 * entry and named by no entry — and a positional selector is a stack of one.
 * Plugins and paths accumulate bottom first; `env` and `settings` merge
 * key-wise, the topmost entry winning (src/profile/resolve.ts `merge`). Each
 * directory is read exactly as the launcher's own is, then translated once per
 * content into
 * `${XDG_CACHE_HOME:-~/.cache}/agent-distro/plugins/<key>/<harness>/<translator>`.
 * The key is the plugin's own path when it is under /nix/store, which is
 * already content-addressed; otherwise it hashes the directory's path together
 * with what a translation reads of it — the description, and the bytes and
 * mode of each skill file it lists — so the rest of a checkout is never read
 * and cannot fail the launch, while a translation that embeds the root stays
 * particular to it.
 * `<translator>` names the runtime and the adapter's inputs, so a new
 * agent-distro never reads an older translation.
 *
 * Every use stamps a translation's link; a launch that translates something
 * new also removes what no launch has used for STALE_DAYS, so the cache holds
 * what is in use rather than every version ever seen.
 *
 * Plugins are matched by manifest name, never by version: a plugin on the
 * variable, or of a profile above, replaces the plugin of the same name from a
 * profile below it, and among those the last of a name wins.
 *
 * A launch names the profile in effect on stderr when a repository's
 * profile or AI_PROFILE chose it — the whole stack, from the bottom
 * up, worded as `--list` words it and followed by the website (`SITE`) — since
 * that line is the only one a plain launch prints and the change to plugins,
 * PATH, env and settings is silent otherwise. At debug it also logs each plugin
 * directory and where it came
 * from, the PATH additions, the environment and settings, and the arguments it
 * hands the harness.
 */
import { createHash, randomBytes, type Hash } from 'node:crypto';
import {
  lstatSync, lutimesSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Fatal, isDescription, readPlugin, type Description } from './read.ts';
import { log, SITE, VARIABLE as LOG_VARIABLE } from '../log.ts';
import { nameText, sourceText } from '../listing.ts';
import { isSystemError, realpath, writeTemporary } from '../util.ts';
import {
  resolveProfile, select, workingDirectory, isResolved,
  type Described, type Info, type ProfileEnv, type Resolved, type SettingsSection,
} from '../profile/resolve.ts';

export type Report = (message: string) => void;

/** A plugin, translated for one harness. */
export type LaunchPlugin = {
  name: string;
  key: string;
  description: Description;
  /** Where it was named, as `resolve` labels it: `profile` or AGENT_DISTRO_PLUGINS. */
  from: string;
  /** The adapter's cached translation; never written to after it is returned. */
  translation: string;
};

export type Launch<A> = {
  args: A;
  /** The profiles' plugins and the variable's, deduplicated, in order; empty when there are none. */
  plugins: LaunchPlugin[];
  /** `${XDG_CACHE_HOME:-~/.cache}/agent-distro`; null when `plugins` is empty. */
  cache: string | null;
  report: Report;
};

export interface Adapter<A = unknown, I = unknown> {
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
  launch(launch: Launch<A>): string;
}

/** A launch the variable cannot serve; the message names what is wrong. */
export class LaunchError extends Error {}

export const VARIABLE = 'AGENT_DISTRO_PLUGINS';

/**
 * The cache root, or null when there is nowhere to keep one: XDG_CACHE_HOME and
 * HOME are both unset, so a launch without a home still starts — what needs
 * caching is skipped, and each caller says so — instead of not starting at all.
 * A cache that is *given* and unusable is still an error (`cacheRoot`).
 */
export function cacheRootIfAny(env: NodeJS.ProcessEnv = process.env, label = VARIABLE): string | null {
  return env.XDG_CACHE_HOME || env.HOME ? cacheRoot(env, label) : null;
}

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

export { printable } from '../util.ts';

/** A length and then the bytes: two fields never serialize to the same input. */
function field(hash: Hash, value: string | Buffer) {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  hash.update(length).update(bytes);
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
 * (never of the contents). Any other directory is keyed by its path and by
 * what a translation reads of it — `description`, and the bytes and mode of
 * every skill file it lists — so nothing else in the tree is read, and a
 * `node_modules`, a build output or a live socket beside them costs nothing.
 */
export function cacheKey(root: string, description: Description): string {
  if (root.startsWith(STORE) && root.length > STORE.length) {
    const relative = root.slice(STORE.length);
    const key = 'store-' + encodeURIComponent(relative);
    if (Buffer.byteLength(key) <= NAME_MAX) return key;
    // `#` is one character encodeURIComponent always escapes, so this form
    // cannot be the encoding of any path.
    return 'store-' + encodeURIComponent(relative.split('/')[0]).slice(0, 120) + '#' + sha256(relative);
  }
  const hash = createHash('sha256');
  field(hash, 'agent-distro plugin');
  field(hash, root);
  field(hash, JSON.stringify(description));
  for (const [skill, files] of Object.entries(description.skills)) {
    for (const file of files) {
      // As the reader resolved it: a link is followed to the file it names.
      const path = realpath(join(root, 'skills', skill, file));
      field(hash, skill);
      field(hash, file);
      // copySkills copies a file's mode too (src/plugin/resources.ts), so the
      // mode is part of what a translation holds.
      field(hash, (statSync(path).mode & 0o7777).toString(8));
      field(hash, readFileSync(path));
    }
  }
  return 'sha256-' + hash.digest('hex');
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
 * says what the first one did. `known` is a description the plugin's writer
 * already holds (a built profile's, whose `reader` is this runtime), used in
 * place of reading `entry` again and hence never re-read to check the key.
 */
export function translate(
  entry: string, harness: string, adapter: Adapter, args: unknown, cache: string, report: Report, label = VARIABLE,
  known?: Description,
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
    return { name: description.manifest.name, key, description, from: label, translation: join(directory, 'out') };
  };

  // What a translation reads of a checkout is its description and the skill
  // files that lists, so those are what it is keyed by. A checkout can still
  // change while it is read; it is read and keyed again afterwards, and a
  // translation whose source changed under it is never published.
  for (let attempt = 1; ; attempt++) {
    const reports: string[] = [];
    let description: Description;
    if (known) {
      description = known;
    } else {
      try {
        description = readPlugin(root, (message) => reports.push(message));
      } catch (error) {
        if (error instanceof Fatal) throw new LaunchError(`${label}: ${entry}: invalid Agent Plugin: ${error.message}`);
        throw error;
      }
    }
    const key = cacheKey(root, description);
    const parent = join(cache, 'plugins', key, harness);
    const link = join(parent, translator);
    const existing = cached(link);
    if (existing) return replay(key, link, existing);

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
      // Read and key it again, and publish only what did not move: a store
      // path cannot change, and a `known` description is the build's own word
      // for what the root holds.
      if (!known && !(root.startsWith(STORE) && root.length > STORE.length)) {
        let again: Description | null = null;
        try {
          again = readPlugin(root);
        } catch (error) {
          // It changed into something invalid under us: the same as any other
          // change, so the attempt is retried.
          if (!(error instanceof Fatal)) throw error;
        }
        if (again === null || cacheKey(root, again) !== key) {
          rmSync(directory, { recursive: true, force: true });
          if (attempt === 3) throw new LaunchError(`${label}: ${entry} kept changing while it was translated`);
          continue;
        }
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
 * Resolve the variable against the profiles in effect: which plugins load, and
 * where each came from. `own`, the plugin directories of the profile in
 * effect, come before the variable's, and the last of a name wins. `described`
 * are the descriptions a built profile of the stack already holds, by root
 * (src/profile/resolve.ts `Described`): a plugin whose root they cover is not
 * read again. `from` names the profile in effect, in errors about its plugins
 * and as where each came from.
 */
export function resolve<A>(
  harness: string, adapter: Adapter<A>, args: A, value: string | undefined, env: NodeJS.ProcessEnv, report: Report,
  own: string[] = [], described: Described[] = [], from = 'profile',
): Launch<A> {
  const known = new Map<string, Description>();
  for (const { root, description: path } of described) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isDescription(value)) known.set(root, value);
    } catch (error) {
      // A description that cannot be read is this profile's to do without:
      // the plugin's root is read instead.
      if (!(error instanceof SyntaxError) && !isSystemError(error)) throw error;
      log.plugin.debug(`cannot read ${path}: ${(error as Error).message}`);
    }
  }
  let names = [...own, ...entries(value)];
  // Nothing to load needs no cache, so it cannot fail for want of one.
  const label = own.length > 0 ? from : VARIABLE;
  let cache = names.length > 0 ? cacheRootIfAny(env, label) : null;
  if (names.length > 0 && cache === null) {
    // No cache to translate into: the launch starts without the plugins rather
    // than not starting at all, and says so (as a launch without a home does).
    log.plugin.warn(`${label}: XDG_CACHE_HOME and HOME are unset; skipping plugins that need translating`);
    names = [];
    cache = null;
  }
  const byName = new Map<string, LaunchPlugin>();
  for (const [i, entry] of names.entries()) {
    const plugin = translate(entry, harness, adapter, args, cache!, report, i < own.length ? from : VARIABLE,
      known.get(realpath(entry)));
    // The last of a name wins, in its own position.
    byName.delete(plugin.name);
    byName.set(plugin.name, plugin);
  }
  return { args, cache, report, plugins: [...byName.values()] };
}

/** One POSIX shell word, always quoted. */
const quote = (value: string) => "'" + value.replace(/'/g, `'"'"'`) + "'";

/**
 * The profile in effect: the one the picker resolved, handed over in
 * AGENT_DISTRO_PROFILE, else this launch's own resolution; null when there is
 * none at all.
 */
function profileInEffect(info: Info, env: NodeJS.ProcessEnv): Resolved | null {
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
  return resolveProfile(info, select(undefined, workingDirectory(), env), env);
}

/**
 * The shell a launcher evaluates; see the head of this file. Every non-secret
 * `env` entry is exported here; a secret one is named in `profile_env_secrets`
 * with its hint, for the launcher to prompt for, so no value of it is ever a
 * file or a command line. `settings` is the profile's settings for this
 * harness, written as JSON.
 */
export function shell(
  launched: string, env: ProfileEnv, settings: SettingsSection | undefined,
  paths: string[], logLevel: string | null = null,
): string {
  const cwd = workingDirectory();
  const secrets: string[] = [];
  const lines = [`launched=${quote(launched)}`, 'unset AGENT_DISTRO_PROFILE'];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') lines.push(`export ${name}=${quote(value)}`);
    else secrets.push(`${name}=${value.hint ?? ''}`);
  }
  lines.push(
    `profile_env_secrets=(${secrets.map(quote).join(' ')})`,
    `profile_settings=${quote(settings ? JSON.stringify(settings) : '')}`,
  );
  // The directory this launch was typed in, for the launchers a plugin's stdio
  // servers run through (src/plugin/launcher.ts). Exported, because the harness
  // passes its environment on.
  if (cwd) lines.push(`AGENT_DISTRO_CWD=${quote(cwd)}`, 'export AGENT_DISTRO_CWD');
  // The level this launch settled on after warning about the one it was given:
  // the harness scripts it runs next take that one as it is, rather than
  // repeating the warning, once each.
  if (logLevel) lines.push(`${LOG_VARIABLE}=${quote(logLevel)}`, `export ${LOG_VARIABLE}`);
  if (paths.length) lines.push(`PATH=${quote(paths.join(':'))}"\${PATH:+:$PATH}"`, 'export PATH');
  return lines.join('\n') + '\n';
}

/**
 * What a launch says about itself: the profile at info when one was chosen
 * here, the rest at debug. `settings` is this harness's section of the
 * profile's, absent for a harness it says nothing about, and `opted` whether
 * `AGENT_DISTRO_SETTINGS=0` left everything the profile sets out. With no
 * profile in effect, nothing was added to the harness.
 */
function describe<A>(
  harness: string, profile: Resolved | null, launch: Launch<A>, launched: string,
  settings: SettingsSection | undefined, opted: boolean,
) {
  if (profile?.source === 'repository' || profile?.source === 'variable') {
    log.profile.info(`using ${nameText(profile)} (${sourceText(profile)}) · ${SITE}`);
  }
  log.profile.debug(profile ? `profile ${nameText(profile)}, ${sourceText(profile)}` : 'no profile in effect');
  for (const plugin of launch.plugins) {
    log.plugin.debug(`${plugin.description.root}: from ${plugin.from}, as ${plugin.name}, translated at ${plugin.translation}`);
  }
  for (const path of profile?.paths ?? []) log.profile.debug(`PATH gains ${path}`);
  if (opted) log.profile.debug('AGENT_DISTRO_SETTINGS=0: no environment or settings from the profile');
  else if (profile) {
    for (const [name, value] of Object.entries(profile.env)) {
      log.profile.debug(typeof value === 'string' ? `exports ${name}=${value}`
        : `prompts for ${name}${value.hint ? ` (${value.hint})` : ''}`);
    }
    if (settings) log.profile.debug(`settings.${harness} from the profile`);
    else if (Object.keys(profile.settings[harness] ?? {}).length) log.profile.debug(`settings.${harness} is for another harness`);
  }
  log.harness(harness).debug(`harness arguments: ${launched}`);
}

export async function main(argsPath: string): Promise<number> {
  const args = JSON.parse(readFileSync(argsPath, 'utf8'));
  const report: Report = (message) => log.plugin.warn(message);
  // The failure is reported by the component it comes from, as `--list`
  // reports the same profile failure, not by whichever harness was launched.
  let logger = log.profile;
  try {
    const profile = profileInEffect(args, process.env);
    logger = log.plugin;
    const { adapter } = await import(`../harness/${args.harness}.ts`) as { adapter: Adapter };
    const launch = resolve(args.harness, adapter, args, process.env[VARIABLE], process.env, report,
      profile?.plugins ?? [], profile?.descriptions ?? [], profile ? `profile ${profile.origin}` : undefined);
    logger = log.harness(args.harness);
    const launched = adapter.launch(launch);
    // `AGENT_DISTRO_SETTINGS=0` is plugins only: the profile sets nothing, and
    // a secret variable is not this launch's to export either — the launcher
    // prompts for it after this shell, so its value is never a file or an argv.
    const opted = process.env.AGENT_DISTRO_SETTINGS === '0';
    // An empty section is no section: a profile that carries `settings.omp = { }`
    // has configured nothing for the harness, so it is handed no settings (and
    // the launcher writes no empty layer) exactly as if it had none at all.
    const section = opted ? undefined : profile?.settings[args.harness];
    const settings = section && Object.keys(section).length ? section : undefined;
    describe(args.harness, profile, launch, launched, settings, opted);
    process.stdout.write(shell(launched, opted || !profile ? {} : profile.env, settings, profile?.paths ?? [],
      log.unknown ? log.level : null));
  } catch (error) {
    if (!(error instanceof LaunchError) && !isSystemError(error)) throw error;
    // A cache that cannot be written fails the launch: there is no degraded mode.
    logger.error((error as Error).message);
    return 1;
  }
  return 0;
}
