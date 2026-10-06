/**
 * Load the Agent Plugins named by AGENT_DISTRO_PLUGINS into one launch.
 *
 * Usage: node launch.ts ARGS_JSON [BASE]
 *
 * ARGS_JSON is written by a harness launcher at build time: `harness` names the
 * adapter (`src/harness/<harness>.ts`, which exports `adapter`), `profile` lists
 * the profile's plugins as `{ description, ... }` entries, and the rest is the
 * adapter's own. What the adapter prints (extra arguments as shell words, or a
 * path) goes to stdout for the launcher to use.
 *
 * Each directory on the variable is read exactly as a profile plugin is, then
 * translated once per content into
 * `${XDG_CACHE_HOME:-~/.cache}/agent-distro/plugins/<key>/<harness>/<translator>`.
 * The key is the plugin's own path when it is under /nix/store, which is
 * already content-addressed; otherwise it hashes the directory's NAR
 * serialization together with its path, since translations embed the root.
 * `<translator>` names the runtime and the adapter's inputs, so a new
 * agent-distro never reads an older translation.
 *
 * Plugins are matched by manifest name, never by version: a plugin on the
 * variable replaces the profile's plugin of the same name, and on the variable
 * the last of a name wins.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Fatal, readPlugin, type Description } from './read.ts';
import { readDescription } from './resources.ts';
import { isDirectory, isSystemError, realpath, writeTemporary } from '../util.ts';

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
  /** The variable's plugins, deduplicated, in order. */
  plugins: LaunchPlugin[];
  /** Arguments after ARGS_JSON, such as a configuration to extend. */
  rest: string[];
  /** `${XDG_CACHE_HOME:-~/.cache}/agent-distro`. */
  cache: string;
  report: Report;
};

export interface Adapter<A = any, E extends ProfileEntry = ProfileEntry> {
  /** Everything besides the plugin that shapes `translate`'s output. */
  translationInputs(args: A): unknown;
  /** Write one plugin's translation into the empty directory `out`. */
  translate(description: Description, out: string, args: A, report: Report, key: string): void;
  /** What the launcher reads from stdout. */
  launch(launch: Launch<A, E>): string;
}

/** A launch the variable cannot serve; the message names what is wrong. */
export class LaunchError extends Error {}

export const VARIABLE = 'AGENT_DISTRO_PLUGINS';

/** `${XDG_CACHE_HOME:-$HOME/.cache}/agent-distro`. */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME || (env.HOME ? join(env.HOME, '.cache') : '');
  if (!base) throw new LaunchError(`${VARIABLE}: cannot cache translations: XDG_CACHE_HOME and HOME are unset`);
  return join(base, 'agent-distro');
}

/** The variable's entries in order; empty components are ignored. */
export function entries(value: string | undefined): string[] {
  return (value ?? '').split(':').filter((entry) => entry !== '');
}

function narString(hash: ReturnType<typeof createHash>, value: string | Buffer) {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
  if (bytes.length % 8) hash.update(Buffer.alloc(8 - (bytes.length % 8)));
}

function narNode(hash: ReturnType<typeof createHash>, path: string) {
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
        put('entry', '(', 'name', name, 'node');
        narNode(hash, join(path, name.toString()));
        put(')');
      }
    } else {
      throw new LaunchError(`${VARIABLE}: ${path} is not a regular file, directory or symlink, so it cannot be hashed`);
    }
  } finally {
    closeSync(fd);
  }
  put(')');
}

/** SHA-256 of the directory's NAR serialization, as `nix-hash --type sha256` prints it. */
export function narHash(path: string): string {
  const hash = createHash('sha256');
  narString(hash, 'nix-archive-1');
  narNode(hash, path);
  return hash.digest('hex');
}

const STORE = '/nix/store/';

/**
 * The cache key of a resolved plugin root: its store path, used as is, or a
 * hash of its contents and its path. A key is one file name, injectively.
 */
export function cacheKey(root: string): string {
  if (root.startsWith(STORE) && root.length > STORE.length) {
    return 'store-' + encodeURIComponent(root.slice(STORE.length));
  }
  const digest = createHash('sha256').update(`agent-distro plugin\0${root}\0${narHash(root)}`).digest('hex');
  return 'sha256-' + digest;
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
  if (isDirectory(directory)) return directory;
  // The directory was removed by hand; translate again.
  rmSync(link, { force: true });
  return null;
}

/**
 * The cached translation of the plugin at `entry` for one adapter, writing it
 * first when absent. Reports are replayed from the cache, so a cached launch
 * says what the first one did.
 */
export function translate(entry: string, harness: string, adapter: Adapter, args: unknown, cache: string, report: Report): LaunchPlugin {
  const root = realpath(entry);
  if (!isDirectory(root)) throw new LaunchError(`${VARIABLE}: ${entry} is not a directory`);
  const key = cacheKey(root);
  const translator = createHash('sha256')
    .update(JSON.stringify({ runtime: import.meta.dirname, inputs: adapter.translationInputs(args) }))
    .digest('hex').slice(0, 32);
  const parent = join(cache, 'plugins', key, harness);
  const link = join(parent, translator);
  const replay = (directory: string) => {
    const reports: string[] = JSON.parse(readFileSync(join(directory, 'reports.json'), 'utf8'));
    for (const message of reports) report(`${entry}: ${message}`);
    const description = readDescription(join(directory, 'description.json'));
    return { name: description.manifest.name, key, description, translation: join(directory, 'out') };
  };
  const existing = cached(link);
  if (existing) return replay(existing);

  const reports: string[] = [];
  let description: Description;
  try {
    description = readPlugin(root, (message) => reports.push(message));
  } catch (error) {
    if (error instanceof Fatal) throw new LaunchError(`${VARIABLE}: ${entry}: invalid Agent Plugin: ${error.message}`);
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
    adapter.translate(description, join(directory, 'out'), args, (message) => reports.push(message), key);
    writeFileSync(join(directory, 'reports.json'), JSON.stringify(reports));
    symlinkSync(name, link);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    // A concurrent launch finished the same translation first.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = cached(link);
      if (winner) return replay(winner);
    }
    throw error;
  }
  return replay(directory);
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

/** A JSON document stored under the cache by the hash of its contents. */
export function writeAddressed(directory: string, data: unknown): string {
  const text = JSON.stringify(data, null, 2) + '\n';
  const path = join(directory, createHash('sha256').update(text).digest('hex') + '.json');
  writeAtomic(path, text);
  return path;
}

/** Resolve the variable against the profile: who stays, who is replaced, who is added. */
export function resolve<A extends { profile: E[] }, E extends ProfileEntry>(
  harness: string, adapter: Adapter<A, E>, args: A, value: string | undefined, cache: string, report: Report,
): Omit<Launch<A, E>, 'rest'> {
  const byName = new Map<string, LaunchPlugin>();
  for (const entry of entries(value)) {
    const plugin = translate(entry, harness, adapter, args, cache, report);
    // The last of a name wins, in its own position.
    byName.delete(plugin.name);
    byName.set(plugin.name, plugin);
  }
  const profile = args.profile.map((entry) => {
    const description = readDescription(entry.description);
    return { name: description.manifest.name, description, entry };
  });
  return {
    args, cache, report,
    kept: profile.filter((plugin) => !byName.has(plugin.name)),
    replaced: profile.filter((plugin) => byName.has(plugin.name)),
    plugins: [...byName.values()],
  };
}

async function main(argsPath: string, rest: string[]): Promise<number> {
  const args = JSON.parse(readFileSync(argsPath, 'utf8'));
  const report: Report = (message) => process.stderr.write(message + '\n');
  try {
    const { adapter } = await import(`../harness/${args.harness}.ts`) as { adapter: Adapter };
    const launch = resolve(args.harness, adapter, args, process.env[VARIABLE], cacheRoot(), report);
    process.stdout.write(adapter.launch({ ...launch, rest }));
  } catch (error) {
    if (!(error instanceof LaunchError) && !isSystemError(error)) throw error;
    // A cache that cannot be written fails the launch: there is no degraded mode.
    process.stderr.write(`agent-distro: ${(error as Error).message}\n`);
    return 1;
  }
  return 0;
}

// Not a top-level await: the adapter imports this module, which must finish
// evaluating first.
if (import.meta.main) main(process.argv[2], process.argv.slice(3)).then((code) => (process.exitCode = code));
