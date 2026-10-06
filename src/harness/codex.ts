/**
 * Codex's side of AGENT_DISTRO_PLUGINS, run by src/plugin/launch.ts.
 *
 * Codex loads a plugin only from its own install cache, and only while its
 * config enables it. The marketplace and the enablement can both be given for
 * one launch with `-c`, so neither is written to config.toml: each plugin
 * gets a one-plugin marketplace named after its cache key, Codex's own
 * installer copies it into the cache (through a throwaway CODEX_HOME whose
 * `plugins` is the real one, so the user's config is never touched), and the
 * launch passes `-c` overrides that enable it and disable the profile plugin it
 * replaces. The cached copy stays behind, inert without the override; a changed
 * plugin is a new key and a new copy.
 *
 * Codex's `-c` splits its key at every ".", so a plugin whose name contains one
 * cannot be enabled or disabled this way; it is reported and skipped.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LaunchError, type Adapter, type ProfileEntry } from '../plugin/launch.ts';
import { shellQuote } from '../plugin/launcher.ts';

type LaunchArgs = { codex: string; marketplace: string; profile: ProfileEntry[] };

const marketplaceName = (key: string) => 'agent-distro-' + createHash('sha256').update(key).digest('hex').slice(0, 16);

/** A TOML basic string; JSON's escapes are all valid TOML. */
const tomlString = (value: string) => JSON.stringify(value);

export const adapter: Adapter<LaunchArgs> = {
  translationInputs: () => null,
  translate: (description, out, _args, _report, key) => {
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
    const home = process.env.CODEX_HOME || (process.env.HOME ? join(process.env.HOME, '.codex') : '');
    if (!home) throw new LaunchError('Codex: cannot install plugins: CODEX_HOME and HOME are unset');
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
    for (const plugin of plugins) {
      if (!settable(plugin.name, 'enable')) continue;
      const marketplace = marketplaceName(plugin.key);
      const source = `marketplaces.${marketplace}={source_type="local",source=${tomlString(plugin.translation)}}`;
      if (!existsSync(join(home, 'plugins/cache', marketplace, plugin.name))) install(home, args.codex, source, `${plugin.name}@${marketplace}`);
      override(source);
      override(`plugins.${plugin.name}@${marketplace}.enabled=true`);
    }
    return words.join(' ');
  },
};

/** Codex's own installer, writing only to the real install cache. */
function install(home: string, codex: string, source: string, id: string) {
  mkdirSync(join(home, 'plugins'), { recursive: true });
  const scratch = mkdtempSync(join(home, '.agent-distro-install-'));
  try {
    symlinkSync(join(home, 'plugins'), join(scratch, 'plugins'));
    const result = spawnSync(codex, ['-c', source, 'plugin', 'add', id], {
      env: { ...process.env, CODEX_HOME: scratch }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new LaunchError(`Codex: cannot install ${id}: ${(result.stderr || String(result.error)).trim()}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
