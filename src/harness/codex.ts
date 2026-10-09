/**
 * Codex's side of AGENT_DISTRO_PLUGINS, run by src/plugin/launch.ts.
 *
 * Codex loads a plugin only from its own install cache, and only while its
 * config enables it. The marketplace and the enablement can both be given for
 * one launch with `-c`, so neither is written to config.toml: each plugin gets
 * a one-plugin marketplace named after its cache key, and the launch passes
 * `-c` overrides that register it, enable the plugin, and disable the profile
 * plugin it replaces.
 *
 * Codex's own installer puts the plugin in the install cache. It runs with a
 * throwaway CODEX_HOME, empty but for what it writes (`plugin add` from a local
 * marketplace needs no login), and the marketplace's directory it produced is
 * then renamed into `$CODEX_HOME/plugins/cache`. A rename is atomic, so that
 * directory is there only when complete: an interrupted install is simply
 * repeated, and of two concurrent ones the second finds the first's.
 *
 * Installed copies are inert without the override. Each launch stamps the ones
 * it uses, and an install removes those no launch has used for STALE_DAYS,
 * along with scratch homes an interrupted install left behind.
 *
 * Codex's `-c` splits its key at every ".", so a plugin whose name contains one
 * cannot be enabled or disabled this way; it is reported and skipped.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LaunchError, STALE_DAYS, type Adapter, type ProfileEntry } from '../plugin/launch.ts';
import { shellQuote } from '../plugin/launcher.ts';

type LaunchArgs = { codex: string; marketplace: string; profile: ProfileEntry[] };

const PREFIX = 'agent-distro-';
const SCRATCH = '.agent-distro-install-';
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

const marketplaceName = (key: string) => PREFIX + createHash('sha256').update(key).digest('hex').slice(0, 16);

/** A TOML basic string; JSON's escapes are all valid TOML. */
const tomlString = (value: string) => JSON.stringify(value);

export const adapter: Adapter<LaunchArgs, ProfileEntry, null> = {
  translationInputs: () => null,
  translate: (description, out, _inputs, _report, key) => {
    const name = description.manifest.name;
    mkdirSync(join(out, '.agents/plugins'), { recursive: true });
    symlinkSync(description.root, join(out, name));
    writeFileSync(join(out, '.agents/plugins/marketplace.json'), JSON.stringify({
      name: marketplaceName(key),
      plugins: [{
        name,
        source: { source: 'local', path: './' + name },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      }],
    }, null, 2));
  },
  launch: ({ args, replaced, plugins, report }) => {
    if (!plugins.length && !replaced.length) return '';
    const words: string[] = [];
    const override = (value: string) => words.push('-c', shellQuote(value));
    const settable = (name: string, action: string) => {
      if (!name.includes('.')) return true;
      report(`Codex: cannot ${action} plugin ${JSON.stringify(name)} for one launch: its name contains "."`);
      return false;
    };
    for (const plugin of replaced) {
      if (settable(plugin.name, 'disable')) override(`plugins.${plugin.name}@${args.marketplace}.enabled=false`);
    }
    const home = plugins.length ? codexHome() : '';
    for (const plugin of plugins) {
      if (!settable(plugin.name, 'enable')) continue;
      const marketplace = marketplaceName(plugin.key);
      const source = `marketplaces.${marketplace}={source_type="local",source=${tomlString(plugin.translation)}}`;
      ensureInstalled(home, args.codex, source, marketplace, plugin.name);
      override(source);
      override(`plugins.${plugin.name}@${marketplace}.enabled=true`);
    }
    return words.join(' ');
  },
};

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME || (env.HOME ? join(env.HOME, '.codex') : '');
  if (!home) throw new LaunchError('Codex: cannot install plugins: CODEX_HOME and HOME are unset');
  return home;
}

/** Install `name@marketplace` into Codex's cache unless it is there, and stamp it as used. */
export function ensureInstalled(home: string, codex: string, source: string, marketplace: string, name: string) {
  const cache = join(home, 'plugins', 'cache');
  const installed = join(cache, marketplace);
  if (!existsSync(installed)) {
    install(home, codex, source, marketplace, name);
    prune(home, cache, marketplace);
  }
  const now = new Date();
  utimesSync(installed, now, now);
}

function install(home: string, codex: string, source: string, marketplace: string, name: string) {
  const id = `${name}@${marketplace}`;
  const scratch = mkdtempSync(join(home, SCRATCH));
  try {
    const result = spawnSync(codex, ['-c', source, 'plugin', 'add', id], {
      env: { ...process.env, CODEX_HOME: scratch }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
    });
    const built = join(scratch, 'plugins', 'cache', marketplace);
    if (result.status !== 0 || !existsSync(join(built, name))) {
      const detail = (result.stderr || String(result.error ?? `no ${name} in its cache`)).trim();
      throw new LaunchError(`Codex: cannot install ${id}: ${detail}`);
    }
    mkdirSync(join(home, 'plugins', 'cache'), { recursive: true });
    try {
      renameSync(built, join(home, 'plugins', 'cache', marketplace));
    } catch (error) {
      // A concurrent launch installed the same plugin first.
      if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code!)) throw error;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const stale = (path: string, now: number) => now - lstatSync(path).mtimeMs > STALE_MS;

/** Remove our installs no launch has used lately, and abandoned scratch homes. */
function prune(home: string, cache: string, keep: string) {
  const now = Date.now();
  for (const entry of readdirSync(cache)) {
    if (entry.startsWith(PREFIX) && entry !== keep && stale(join(cache, entry), now)) {
      rmSync(join(cache, entry), { recursive: true, force: true });
    }
  }
  for (const entry of readdirSync(home)) {
    // An install takes seconds; a day-old scratch home was interrupted.
    if (entry.startsWith(SCRATCH) && now - lstatSync(join(home, entry)).mtimeMs > 24 * 60 * 60 * 1000) {
      rmSync(join(home, entry), { recursive: true, force: true });
    }
  }
}
