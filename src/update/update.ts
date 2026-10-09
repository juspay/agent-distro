/**
 * Refresh one installed agent-distro profile from its flake, never compiling.
 *
 * Usage: node update.ts CONFIG_JSON                   one update (systemd)
 *        node update.ts CONFIG_JSON --progress        one update, JSON on stdout (a consumer)
 *        node update.ts CONFIG_JSON --scheduled       when due, up to 3 attempts (launchd)
 *        node update.ts CONFIG_JSON --cache-warnings  warn about unusable caches (activation)
 *
 * CONFIG_JSON is written by modules/home-manager.nix. Each run builds the
 * profile's bundle into `<state>/current`, which the shims prefer, and appends
 * what changed to the history log.
 *
 * `--progress` is the same update for a machine rather than a person: stdout
 * carries one JSON object per line — `{"progress":{"done":…,"total":…}}` while
 * the bundle downloads, then one result — and every human line goes to stderr.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { realpath } from '../util.ts';
import { checkCaches } from './cache.ts';
import { updateDue } from './due.ts';
import { NixLog } from './progress.ts';

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

/** What a build would do: compile `names` (empty: nothing), or `unknown` and why. */
export type Plan = { names: string } | { unknown: string };

/** What a run ends with: the bundle it settled on, or why it did not. */
export type Result =
  | { result: 'updated' | 'unchanged'; bundle: string }
  | { result: 'skipped' | 'failed'; reason: string };

/**
 * How one run reports. Plain mode prints for a person; `--progress` puts the
 * machine-readable result and progress on stdout as one JSON object per line,
 * and every human line on stderr, so stdout stays parseable.
 */
export type Report = {
  /** The success summary: stdout in plain mode, stderr under --progress. */
  summary(line: string): void;
  /** A warning or a failure: stderr in either mode. */
  note(line: string): void;
  /** The final result: a JSON line on stdout under --progress, nothing in plain mode. */
  result(result: Result): void;
  /** The bytes fetched so far: a JSON line on stdout under --progress, nothing in plain mode. */
  progress(done: number, total: number): void;
};

const plain: Report = {
  summary: (line) => void process.stdout.write(line),
  note: (line) => void process.stderr.write(line),
  result: () => { },
  progress: () => { },
};

/** The consumer's mode: JSON on stdout, every human line on stderr. */
function jsonReport(): Report {
  const object = (value: object) => void process.stdout.write(`${JSON.stringify(value)}\n`);
  return {
    summary: (line) => void process.stderr.write(line),
    note: (line) => void process.stderr.write(line),
    result: object,
    progress: (done, total) => object({ progress: { done, total } }),
  };
}

/** What a build step exited with, however it was spawned. */
type Build = { status: number | null; signal: NodeJS.Signals | null; error?: Error };

/**
 * The build step under `--progress`. Nix's internal-json stderr is read for the
 * bytes it fetches; everything else nix says is re-emitted, so its errors still
 * reach the user.
 */
function loggedBuild(nix: string, args: string[], log: NixLog, report: Report): Promise<Build> {
  const { promise, resolve } = Promise.withResolvers<Build>();
  const build = spawn(nix, [...args, '--log-format', 'internal-json'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const lines = build.stderr && createInterface({ input: build.stderr, crlfDelay: Infinity });
  lines?.on('line', (line) => {
    const event = log.line(line);
    if (event === null) return;
    if ('text' in event) process.stderr.write(event.text);
    else report.progress(event.progress.done, event.progress.total);
  });
  build.on('error', (error) => resolve({ status: null, signal: null, error }));
  build.on('close', (status, signal) => {
    const held = log.flush();
    if (held) report.progress(held.done, held.total);
    resolve({ status, signal });
  });
  return promise;
}

// `nix derivation show` for a revision the cache does not hold yet runs to
// megabytes; Node's default 1 MiB cap would kill nix and truncate it.
const UNBOUNDED = { encoding: 'utf8', maxBuffer: Infinity } as const;

/**
 * Names of the derivations a build of `target` would compile rather than
 * fetch, at most three. Derivations with allowSubstitutes = false (trivial
 * builders such as symlinkJoin and shell wrappers) are always built locally,
 * so only the substitutable ones count as misses. `nix derivation show` puts
 * that flag in `env` for a plain derivation and in `structuredAttrs` when the
 * builder sets `__structuredAttrs` (writeText, runCommand, …), so look in
 * both. Anything that stops us reading the answer is `unknown`, never
 * "nothing to compile".
 */
export function wouldCompile(nix: string, target: string, options: string[], env: NodeJS.ProcessEnv = process.env): Plan {
  const dryRun = spawnSync(nix, ['build', target, ...options, '--dry-run'], { ...UNBOUNDED, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (dryRun.error) return { unknown: `nix build --dry-run: ${dryRun.error.message}` };
  // A dry run that nix itself fails is deliberately not a skip: the real
  // build then reports the actual eval or network error.
  const drvs = `${dryRun.stdout}\n${dryRun.stderr}`.split('\n')
    .filter((line) => /^ +\/nix\/store\/.*\.drv$/.test(line)).map((line) => line.trim());
  if (!drvs.length) return { names: '' };
  const shown = spawnSync(nix, ['derivation', 'show', ...drvs], { ...UNBOUNDED, env, stdio: ['ignore', 'pipe', 'inherit'] });
  if (shown.error) return { unknown: `nix derivation show: ${shown.error.message}` };
  if (shown.status !== 0) return { unknown: `nix derivation show exited ${shown.status ?? shown.signal}` };
  type Derivation = {
    name: string;
    env?: Record<string, string>;
    structuredAttrs?: Record<string, unknown>;
  };
  let derivations: Record<string, unknown>;
  try {
    const parsed = JSON.parse(shown.stdout);
    derivations = parsed?.derivations ?? parsed;
  } catch (error) {
    return { unknown: `nix derivation show: ${(error as Error).message}` };
  }
  // Only an answer about every derivation the dry run named counts: {}, [],
  // or a partial answer would otherwise read as "nothing to compile".
  // Nix keys them by store path, or by base name in newer releases.
  const shownAs = (drv: string) =>
    typeof derivations === 'object' && derivations !== null && !Array.isArray(derivations)
      ? derivations[drv] ?? derivations[basename(drv)] : undefined;
  const answers = drvs.map(shownAs);
  const missing = drvs.find((_, i) => {
    const answer = answers[i] as Derivation | undefined;
    return typeof answer !== 'object' || answer === null || typeof answer.name !== 'string';
  });
  if (missing) return { unknown: `nix derivation show did not describe ${missing}` };
  const names = (answers as Derivation[])
    .filter((drv) => drv.env?.allowSubstitutes !== '' && drv.structuredAttrs?.allowSubstitutes !== false)
    .map((drv) => drv.name);
  return { names: names.slice(0, 3).join(',') };
}

/**
 * One update; the exit status. A skip is not a failure. `log` reads the bytes
 * of the build's stderr, which only a `--progress` run asks nix to write.
 */
export async function update(config: Config, report: Report = plain, log?: NixLog): Promise<number> {
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
    report.note(`agent-distro: ${profile} update skipped: ${reason}\n`);
    report.result({ result: 'skipped', reason });
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
    { ...UNBOUNDED, stdio: ['inherit', 'pipe', 'inherit'] });
  let ref = '';
  try {
    if (metadata.status === 0) ref = JSON.parse(metadata.stdout).url ?? '';
  } catch {
    ref = '';
  }
  if (typeof ref !== 'string' || !ref) {
    report.note(`agent-distro: ${profile} update failed (cannot resolve ${config.flake})\n`);
    record('failed: cannot resolve flake');
    report.result({ result: 'failed', reason: 'cannot resolve flake' });
    return 1;
  }
  const target = `${ref}#${profile}`;
  // Never compile on a cache miss, nor when what would be built is unknown.
  const plan = wouldCompile(nix, target, options);
  if ('unknown' in plan) return skip(`cannot tell what the bundle would build (${plan.unknown})`);
  if (plan.names) return skip(`bundle not fully cached yet (would build ${plan.names})`);

  // Read versions before nix build replaces the current out-link.
  const previous = old ? versions(old) : null;
  const args = ['build', target, ...options, '--out-link', current];
  const build: Build = log
    ? await loggedBuild(nix, args, log, report)
    : spawnSync(nix, args, { stdio: 'inherit' });
  if (build.error || build.status !== 0) {
    // As bash reports it: 127 for a nix that is gone (say, garbage-collected),
    // 126 for one that cannot run, a signal's number plus 128.
    const code = (build.error as NodeJS.ErrnoException | undefined)?.code;
    const status = build.error ? (code === 'ENOENT' ? 127 : 126)
      : build.status ?? 128 + (constants.signals[build.signal!] ?? 0);
    if (build.error) report.note(`agent-distro: cannot run ${nix}: ${build.error.message}\n`);
    report.note(`agent-distro: ${profile} update failed (exit ${status})\n`);
    record(`failed: nix build exit ${status}`);
    report.result({ result: 'failed', reason: `nix build exit ${status}` });
    return status;
  }
  const next = realpath(current);
  writeFileSync(join(state, 'last-success.tmp'), `${Math.floor(Date.now() / 1000)}\n`);
  renameSync(join(state, 'last-success.tmp'), join(state, 'last-success'));
  if (next === old) {
    report.summary(`agent-distro: ${profile} unchanged (${next})\n`);
    report.result({ result: 'unchanged', bundle: next });
  } else {
    record(`updated: ${changes(previous, versions(next))}`);
    report.summary(`agent-distro: ${profile} updated ${old || 'nothing'} -> ${next}\n`);
    report.result({ result: 'updated', bundle: next });
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
      status = await update(config);
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
  if (mode === undefined) process.exitCode = await update(config);
  else if (mode === '--progress') process.exitCode = await update(config, jsonReport(), new NixLog());
  else if (mode === '--scheduled') process.exitCode = await scheduled(config);
  else if (mode === '--cache-warnings') process.exitCode = cacheWarnings(config);
  else throw new Error(`unknown mode: ${mode}`);
}
