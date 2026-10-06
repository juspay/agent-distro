/**
 * Refresh one installed agent-distro profile from its flake, never compiling.
 *
 * Usage: node update.ts CONFIG_JSON                   one update (systemd)
 *        node update.ts CONFIG_JSON --scheduled       when due, up to 3 attempts (launchd)
 *        node update.ts CONFIG_JSON --cache-warnings  warn about unusable caches (activation)
 *
 * CONFIG_JSON is written by modules/home-manager.nix. Each run builds the
 * profile's bundle into `<state>/current`, which the shims prefer, and appends
 * what changed to the history log.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { realpath } from '../util.ts';
import { checkCaches } from './cache.ts';
import { updateDue } from './due.ts';

type Config = {
  profile: string;
  flake: string;
  /** This source's state directory: `current`, `last-success`. */
  state: string;
  history: string;
  nix: string;
  /** Binary cache URL → public key. */
  substituters: Record<string, string>;
  /** The launchd schedule: one period per run, phased onto the first hour. */
  periodSeconds: number;
  offsetSeconds: number;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time as `date +%Y-%m-%dT%H:%M:%S%:z` writes it. */
function timestamp(date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const zone = (offset < 0 ? '-' : '+') + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
}

/** name → [title, version], from a bundle's share/agent-distro/versions. */
function versions(bundle: string): Map<string, [string, string]> | null {
  const path = join(bundle, 'share/agent-distro/versions');
  if (!existsSync(path)) return null;
  return new Map(readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    const [name, title, ...version] = line.split('\t');
    return [name, [title, version.join('\t')]];
  }));
}

/** What changed between two bundles, as the history log reports it. */
function changes(previous: Map<string, [string, string]> | null, next: Map<string, [string, string]> | null): string {
  if (next === null) return 'versions not recorded by this bundle';
  const result: string[] = [];
  for (const [name, [title, version]] of next) {
    const old = previous?.get(name);
    if (previous === null) result.push(`${title} ${version}`);
    else if (old === undefined) result.push(`${title} added ${version}`);
    else if (old[1] !== version) result.push(`${title} ${old[1]} → ${version}`);
  }
  for (const [name, [title]] of previous ?? []) {
    if (!next.has(name)) result.push(`${title} removed`);
  }
  return result.join(', ') || 'no harness version changed';
}

/**
 * Names of the derivations a build of `target` would compile rather than
 * fetch, at most three. Derivations with allowSubstitutes = false (trivial
 * builders such as symlinkJoin and shell wrappers) are always built locally,
 * so only the substitutable ones count as misses.
 */
function wouldCompile(nix: string, target: string, options: string[]): string {
  // A failing dry run is deliberately ignored: the real build then reports
  // the actual eval or network error.
  const dryRun = spawnSync(nix, ['build', target, ...options, '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const drvs = `${dryRun.stdout ?? ''}\n${dryRun.stderr ?? ''}`.split('\n')
    .filter((line) => /^ +\/nix\/store\/.*\.drv$/.test(line)).map((line) => line.trim());
  if (!drvs.length) return '';
  const shown = spawnSync(nix, ['derivation', 'show', ...drvs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const parsed = JSON.parse(shown.stdout);
    const derivations: Record<string, { name: string; env?: Record<string, string> }> = parsed.derivations ?? parsed;
    return Object.values(derivations).filter((drv) => drv.env?.allowSubstitutes !== '')
      .slice(0, 3).map((drv) => drv.name).join(',');
  } catch {
    return '';
  }
}

/** One update; the exit status. A skip is not a failure. */
export function update(config: Config): number {
  const { profile, state, history, nix } = config;
  mkdirSync(state, { recursive: true });
  const current = join(state, 'current');
  // Empty before the first run.
  const old = lstatSync(current, { throwIfNoEntry: false }) ? realpath(current) : '';
  const record = (event: string) => appendFileSync(history, `${timestamp()} ${profile} ${event}\n`);
  // A skipped update is not a failure: exiting 0 avoids the pointless restart
  // loop, and last-success stays untouched so launchd tries again next hour.
  // Repeats of the same reason are logged once.
  const skip = (reason: string) => {
    process.stderr.write(`agent-distro: ${profile} update skipped: ${reason}\n`);
    const lines = existsSync(history) ? readFileSync(history, 'utf8').split('\n') : [];
    if (lines.at(-1) === '') lines.pop();
    if ((lines.at(-1) ?? '').split(' ').slice(2).join(' ') !== `skipped: ${reason}`) record(`skipped: ${reason}`);
    return 0;
  };

  const caches = checkCaches(nix, config.substituters);
  const usable = caches.filter((cache) => cache.usable);
  const unusable = caches.filter((cache) => !cache.usable);
  if (unusable.length && !usable.length) {
    return skip(`cache ${unusable.map((cache) => cache.url).join(' ')} not usable; `
      + 'add it to nix.settings substituters/trusted-public-keys');
  }
  const options = usable.length
    ? ['--option', 'extra-substituters', usable.map((cache) => cache.url).join(' '),
      '--option', 'extra-trusted-public-keys', usable.map((cache) => cache.key).join(' ')]
    : [];

  // Lock once so the dry run and the build see the same revision.
  const metadata = spawnSync(nix, ['flake', 'metadata', '--refresh', '--json', config.flake],
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  let ref = '';
  try {
    if (metadata.status === 0) ref = JSON.parse(metadata.stdout).url ?? '';
  } catch {
    ref = '';
  }
  if (typeof ref !== 'string' || !ref) {
    process.stderr.write(`agent-distro: ${profile} update failed (cannot resolve ${config.flake})\n`);
    record('failed: cannot resolve flake');
    return 1;
  }
  const target = `${ref}#${profile}`;
  // Never compile on a cache miss.
  const missing = wouldCompile(nix, target, options);
  if (missing) return skip(`bundle not fully cached yet (would build ${missing})`);

  // Read versions before nix build replaces the current out-link.
  const previous = old ? versions(old) : null;
  const build = spawnSync(nix, ['build', target, ...options, '--out-link', current], { stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    // As bash reports it: a signal's number plus 128.
    const status = build.status ?? 128 + (constants.signals[build.signal!] ?? 0);
    process.stderr.write(`agent-distro: ${profile} update failed (exit ${status})\n`);
    record(`failed: nix build exit ${status}`);
    return status;
  }
  const next = realpath(current);
  writeFileSync(join(state, 'last-success.tmp'), `${Math.floor(Date.now() / 1000)}\n`);
  renameSync(join(state, 'last-success.tmp'), join(state, 'last-success'));
  if (next === old) {
    process.stdout.write(`agent-distro: ${profile} unchanged (${next})\n`);
  } else {
    record(`updated: ${changes(previous, versions(next))}`);
    process.stdout.write(`agent-distro: ${profile} updated ${old || 'nothing'} -> ${next}\n`);
  }
  return 0;
}

/** When due, up to three attempts five minutes apart: launchd has no restart limit. */
async function scheduled(config: Config): Promise<number> {
  let stamp: number | null = null;
  try {
    const text = readFileSync(join(config.state, 'last-success'), 'utf8').trim();
    // An unreadable stamp counts as no successful update, so it is replaced.
    stamp = /^[0-9]+$/.test(text) ? Number(text) : null;
  } catch {
    stamp = null;
  }
  if (!updateDue(Math.floor(Date.now() / 1000), stamp, config.periodSeconds, config.offsetSeconds)) return 0;
  for (let attempt = 1; ; attempt++) {
    let status: number;
    try {
      status = update(config);
    } catch (error) {
      process.stderr.write(`agent-distro: ${(error as Error).stack ?? error}\n`);
      status = 1;
    }
    if (status === 0) return 0;
    if (attempt === 3) return 1;
    process.stderr.write(`agent-distro: attempt ${attempt} of 3 failed; retrying in 5 minutes\n`);
    await sleep(300_000);
  }
}

function cacheWarnings(config: Config): number {
  for (const cache of checkCaches(config.nix, config.substituters)) {
    if (cache.usable) continue;
    process.stderr.write(`warning: agent-distro cannot use cache ${cache.url}; updates are skipped rather than `
      + 'built from source. Add it to nix.settings substituters and trusted-public-keys.\n');
  }
  return 0;
}

if (import.meta.main) {
  const [path, mode] = process.argv.slice(2);
  const config: Config = JSON.parse(readFileSync(path, 'utf8'));
  if (mode === undefined) process.exitCode = update(config);
  else if (mode === '--scheduled') process.exitCode = await scheduled(config);
  else if (mode === '--cache-warnings') process.exitCode = cacheWarnings(config);
  else throw new Error(`unknown mode: ${mode}`);
}
