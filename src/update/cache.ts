/**
 * Decide whether nix will honour a binary cache. The daemon ignores a
 * non-trusted user's extra-substituters unless the system config already lists
 * the URL and its key, so verify that rather than trust our own --option to
 * take effect.
 */
import { spawnSync } from 'node:child_process';
import { log } from '../log.ts';

export type Cache = { url: string; key: string; usable: boolean };

// Configured URLs may carry trailing slashes; compare without them.
const words = (text: string) => text.split(/\s+/).filter(Boolean);
const trim = (url: string) => url.replace(/\/+$/, '');

/**
 * A trusted user's own --option is honoured; anyone else needs the system
 * config to list both the URL and its key. Pure: callers pass what they observed.
 */
export function cacheUsable(trusted: boolean, substituters: string, keys: string, url: string, key: string): boolean {
  if (trusted) return true;
  return words(substituters).map(trim).includes(trim(url)) && words(keys).includes(key);
}

/** Each configured cache, and whether this user's nix would use it. */
export function checkCaches(nix: string, substituters: Record<string, string>): Cache[] {
  // A nix that cannot answer fails every call below for the same reason, so
  // the warning names the first failure once rather than one per command.
  let failure = '';
  /** What `nix ARGS` prints, or null, with nix's own error at debug, when it fails. */
  const output = (...args: string[]): string | null => {
    log.update.debug(`running ${nix} ${args.join(' ')}`);
    const result = spawnSync(nix, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status === 0) return result.stdout;
    const detail = result.error?.message ?? (result.stderr.trim() || `exit ${result.status ?? result.signal}`);
    log.update.debug(`${nix} ${args.join(' ')} failed: ${detail}`);
    failure ||= `${nix} ${args.join(' ')}: ${detail}`;
    return null;
  };
  let trusted = false;
  const text = output('store', 'info', '--json');
  try {
    const info = text === null ? null : JSON.parse(text);
    // Nix 2.34 reports a boolean; older releases 1. A local (single-user) store
    // has no daemon to distrust us and may omit the field.
    trusted = info !== null && (info.trusted === true || info.trusted === 1 || (info.trusted == null && info.url !== 'daemon'));
  } catch (error) {
    log.update.warn(`nix store info printed unreadable JSON: ${(error as Error).message}`);
    trusted = false;
  }
  const show = (setting: string) => output('config', 'show', setting) ?? '';
  const known = show('substituters') + ' ' + show('trusted-substituters');
  const keys = show('trusted-public-keys');
  if (failure) log.update.warn(`cannot read nix's configuration: ${failure}`);
  return Object.entries(substituters).map(([url, key]) => ({ url, key, usable: cacheUsable(trusted, known, keys, url, key) }));
}
