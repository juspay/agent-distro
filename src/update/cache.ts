/**
 * Decide whether nix will honour a binary cache. The daemon ignores a
 * non-trusted user's extra-substituters unless the system config already lists
 * the URL and its key, so verify that rather than trust our own --option to
 * take effect.
 */
import { spawnSync } from 'node:child_process';

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

function output(nix: string, args: string[]): string | null {
  const result = spawnSync(nix, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout : null;
}

/** Each configured cache, and whether this user's nix would use it. */
export function checkCaches(nix: string, substituters: Record<string, string>): Cache[] {
  let trusted = false;
  try {
    const info = JSON.parse(output(nix, ['store', 'info', '--json']) ?? 'null');
    // Nix 2.34 reports a boolean; older releases 1. A local (single-user) store
    // has no daemon to distrust us and may omit the field.
    trusted = info.trusted === true || info.trusted === 1 || (info.trusted == null && info.url !== 'daemon');
  } catch {
    trusted = false;
  }
  const show = (setting: string) => output(nix, ['config', 'show', setting]) ?? '';
  const known = show('substituters') + ' ' + show('trusted-substituters');
  const keys = show('trusted-public-keys');
  return Object.entries(substituters).map(([url, key]) => ({ url, key, usable: cacheUsable(trusted, known, keys, url, key) }));
}
