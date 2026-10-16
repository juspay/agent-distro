/**
 * Refresh the installed agent-distro package from its flake, never compiling.
 *
 * Usage: node update.ts CONFIG_JSON                   one update (systemd)
 *        node update.ts CONFIG_JSON --progress        one update, JSON on stdout (a consumer)
 *        node update.ts CONFIG_JSON --scheduled       when due, up to 3 attempts (launchd)
 *        node update.ts CONFIG_JSON --cache-warnings  warn about unusable caches (activation)
 *
 * CONFIG_JSON is written by modules/home-manager.nix. Each run builds the
 * package into `<state>/current`, which the shims prefer, and appends
 * what changed to the history log. Where nix will not honour the cache for
 * this user — it drops a non-trusted user's own substituters and keys — the
 * run takes the revision's published *content-addressed* package instead, which
 * needs no signature and no configuration (see `contentAddressed`).
 *
 * `--progress` is the same update for a machine rather than a person: stdout
 * carries one JSON object per line — `{"progress":{"done":…,"total":…}}` while
 * the package downloads, then one result — and every human line goes to stderr.
 *
 * Messages go through src/log.ts, tagged `update`, except what is UI rather
 * than a log: nix's own stderr, passed through, and a plain run's summary,
 * which stays on stdout as it always has. The history log keeps its last
 * HISTORY_LINES lines, trimmed when it has grown past them (see
 * `appendHistory`); a scheduled run first cuts launchd's update.log to its
 * last UPDATE_LOG_BYTES, since launchd never rotates it.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync,
  writeFileSync, writeSync,
} from 'node:fs';
import { constants } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { log, type Logger } from '../log.ts';
import { realpath } from '../util.ts';
import { checkCaches } from './cache.ts';
import { parseStamp, SCHEDULED_ATTEMPTS, SCHEDULED_RETRY_SECONDS, updateDue } from './due.ts';
import { appendHistory } from './history-log.ts';
import { historyLine } from './history.ts';
import { currentLink, lastSuccessFile } from './state.ts';
import { changes, parseVersions, VERSIONS_FILE, type Version } from './versions.ts';
import { ATTRIBUTE, indexEntryUrl, takesContentAddressed } from './ca-index.ts';
import { NixLog, nixErrorDetail } from './progress.ts';

type Config = {
  flake: string;
  /** This source's state directory: `current`, `last-success`. */
  state: string;
  history: string;
  nix: string;
  /** Binary cache URL → public key. */
  substituters: Record<string, string>;
  /** Base URL of the content-addressed index (lib/ca-index.nix, via mkUpdater). */
  caIndex: string;
  /**
   * The flake attribute the index names and the update builds
   * (`packages.<system>.<attribute>`, lib/mk-updater.nix). Absent in a config
   * an older build wrote, which named the one package (src/update/ca-index.ts).
   */
  attribute?: string;
  /** The launchd schedule: one period per run, phased onto the first hour. */
  periodSeconds: number;
  offsetSeconds: number;
};

/** A scheduled run cuts launchd's update.log to this many bytes, the newest. */
export const UPDATE_LOG_BYTES = 1024 * 1024;

/**
 * The index is one request on the update's path; a hanging one must not become
 * the path. Where the index is is `config.caIndex`: mkUpdater writes the one
 * location lib/ca-index.nix states, so nothing repeats it here.
 */
const INDEX_TIMEOUT_MS = 30_000;

/** The harnesses an installed package carries, from its versions file; null when it has none. */
function versions(installed: string): Version[] | null {
  const path = join(installed, VERSIONS_FILE);
  return existsSync(path) ? parseVersions(readFileSync(path, 'utf8')) : null;
}

/** What a build would do: compile `names` (empty: nothing), or `unknown` and why. */
export type Plan = { names: string } | { unknown: string };

/** What a run ends with: the package it settled on, or why it did not. */
export type Result =
  | { result: 'updated' | 'unchanged'; package: string }
  | { result: 'skipped'; reason: string }
  | { result: 'failed'; reason: string; detail?: string };

/**
 * How one run reports. Plain mode prints for a person; `--progress` puts the
 * machine-readable result and progress on stdout as one JSON object per line,
 * and every human line on stderr, so stdout stays parseable.
 */
export type Report = {
  /** The success summary: stdout in plain mode, an info message under --progress. */
  summary(message: string): void;
  /** A skip (`warn`) or a failure (`error`): a message in either mode. */
  note(level: 'warn' | 'error', message: string): void;
  /** The final result: a JSON line on stdout under --progress, nothing in plain mode. */
  result(result: Result): void;
  /** The bytes fetched so far: a JSON line on stdout under --progress, nothing in plain mode. */
  progress(done: number, total: number): void;
};

const note: Report['note'] = (level, message) => log.update[level](message);

const plain: Report = {
  summary: (message) => void process.stdout.write(`agent-distro update: ${message}\n`),
  note,
  result: () => { },
  progress: () => { },
};

/** The consumer's mode: JSON on stdout, every human line on stderr. */
function jsonReport(): Report {
  const object = (value: object) => void process.stdout.write(`${JSON.stringify(value)}\n`);
  return {
    summary: (message) => log.update.info(message),
    note,
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
function loggedBuild(nix: string, args: string[], nixLog: NixLog, report: Report): Promise<Build> {
  const { promise, resolve } = Promise.withResolvers<Build>();
  const build = spawn(nix, [...args, '--log-format', 'internal-json'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const lines = build.stderr && createInterface({ input: build.stderr, crlfDelay: Infinity });
  lines?.on('line', (line) => {
    const event = nixLog.line(line);
    if (event === null) return;
    if ('text' in event) process.stderr.write(event.text);
    else report.progress(event.progress.done, event.progress.total);
  });
  build.on('error', (error) => resolve({ status: null, signal: null, error }));
  build.on('close', (status, signal) => {
    const held = nixLog.flush();
    if (held) report.progress(held.done, held.total);
    resolve({ status, signal });
  });
  return promise;
}

// `nix derivation show` for a revision the cache does not hold yet runs to
// megabytes; Node's default 1 MiB cap would kill nix and truncate it.
const UNBOUNDED = { encoding: 'utf8', maxBuffer: Infinity } as const;

/**
 * One nix step that installs a package. Under `--progress` its stderr is read
 * for the bytes it fetches and its messages re-emitted; otherwise it inherits
 * the terminal, as every other nix call here does.
 */
async function nixStep(nix: string, args: string[], nixLog: NixLog | undefined, report: Report): Promise<Build> {
  return nixLog ? await loggedBuild(nix, args, nixLog, report) : spawnSync(nix, args, { stdio: 'inherit' });
}

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
export function wouldCompile(
  nix: string, target: string, options: string[], env: NodeJS.ProcessEnv = process.env, logger: Logger = log.update,
): Plan {
  logger.debug(`running ${nix} build ${target} ${options.join(' ')} --dry-run`);
  const dryRun = spawnSync(nix, ['build', target, ...options, '--dry-run'], { ...UNBOUNDED, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (dryRun.error) return { unknown: `nix build --dry-run: ${dryRun.error.message}` };
  // A dry run that nix itself fails is deliberately not a skip: the real
  // build then reports the actual eval or network error.
  const drvs = `${dryRun.stdout}\n${dryRun.stderr}`.split('\n')
    .filter((line) => /^ +\/nix\/store\/.*\.drv$/.test(line)).map((line) => line.trim());
  if (!drvs.length) return { names: '' };
  logger.debug(`running ${nix} derivation show ${drvs.join(' ')}`);
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
 * What the index publishes for one package: the signed package's store path, and
 * — on the systems that publish one — its content-addressed rewrite.
 */
type Indexed = { ia: string; ca: string };

/** The system the store builds for, as `nix config show system` names it, or ''. */
function systemOf(nix: string): string {
  const result = spawnSync(nix, ['config', 'show', 'system'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) return result.stdout.trim();
  log.update.debug(`nix config show system failed: ${result.error?.message ?? result.stderr.trim()}`);
  return '';
}

/**
 * The package the index publishes for `revision` on this system, or null when it
 * publishes none: a revision CI has not built since this path existed, a flake
 * that names no revision to key one by, a system the index names the signed
 * package for and nothing rewritten (macOS, where a rewritten Mach-O is killed
 * on exec), or an index that cannot be read.
 */
async function published(nix: string, config: Config, revision: string): Promise<Indexed | null> {
  const system = systemOf(nix);
  // A system that cannot run a rewritten package is not asked for one: its
  // entry names the signed package, and an older one that still names a `ca` is
  // not taken either (src/update/ca-index.ts).
  if (!revision || !system || !takesContentAddressed(system)) return null;
  // The base is a config value, so it is validated before anything is fetched
  // from it (src/update/ca-index.ts): one that is not an https URL without
  // credentials, query or fragment is ignored, and the update then skips.
  const url = indexEntryUrl(config.caIndex, revision, system, config.attribute ?? ATTRIBUTE);
  if (url === null) {
    log.update.warn(`ignoring caIndex ${JSON.stringify(config.caIndex)}: it must be an https URL `
      + 'with no credentials, query or fragment');
    return null;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) });
    if (!response.ok) {
      log.update.debug(`${url.href}: HTTP ${response.status}`);
      return null;
    }
    const value = await response.json() as Partial<Indexed>;
    const storePath = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/nix/store/');
    if (!storePath(value.ia)) {
      log.update.warn(`the index at ${url.href} names no signed package`);
      return null;
    }
    // A `ca` is optional — the entry for a system that publishes none carries
    // the signed package alone — but one that is there must be a store path.
    if (value.ca !== undefined && !storePath(value.ca)) {
      log.update.warn(`the content-addressed index at ${url.href} names a ca that is not a store path`);
      return null;
    }
    return value.ca === undefined ? null : { ia: value.ia, ca: value.ca };
  } catch (error) {
    log.update.debug(`cannot read ${url.href}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * The revision's content-addressed package, installed as `<state>/current`.
 *
 * This is what the update does where `checkCaches` finds no cache this user's
 * nix will honour: nix drops their own `extra-substituters`, their keys and
 * `--no-check-sigs` alike, so the signed package is out of reach, but a
 * content-addressed path is trusted by itself and nix copies it from that same
 * cache for anybody. Copy `<ca>` and realise it — which makes the out-link,
 * and nothing else: no `--option`, no signature, no build.
 *
 * `{ skip }` is why it cannot: no package published for this revision and
 * system, or no configured cache holding the one published.
 */
async function contentAddressed(
  config: Config, report: Report, nixLog: NixLog | undefined, urls: string[], revision: string, current: string,
): Promise<{ skip: string } | { build: Build }> {
  const unpublished = `cache ${urls.join(' ')} not usable and no content-addressed package is published for `
    + `${revision ? `revision ${revision}` : 'the revision this flake is on'}; `
    + 'add it to nix.settings substituters/trusted-public-keys';
  const { nix } = config;
  const entry = await published(nix, config, revision);
  if (entry === null) return { skip: unpublished };
  log.update.debug(`the content-addressed ${entry.ia} is ${entry.ca}`);
  for (const url of urls) {
    // The package is the whole point of this path: a cache that has not caught
    // up with the index, one that holds it but cannot be reached, and a nix
    // that refuses it (2.35 recomputes a self-referential NAR's address
    // differently than 2.34, and neither line accepts the other's form) all
    // skip, as an incomplete cache does.
    const copy: Build = await nixStep(nix, ['copy', '--from', url, entry.ca], nixLog, report);
    if (!copy.error && copy.status === 0) {
      return { build: await nixStep(nix, ['build', entry.ca, '--out-link', current], nixLog, report) };
    }
    log.update.debug(`nix copy --from ${url} ${entry.ca} failed: `
      + `${copy.error?.message ?? `exit ${copy.status ?? copy.signal}`}`);
  }
  // Not "not in the cache yet": the cache holding it is not enough for a nix
  // that cannot verify it, so the reason claims no more than the copy.
  return { skip: `content-addressed package ${entry.ca} could not be copied from ${urls.join(' ')}` };
}

/**
 * Cut `path` to its last `bytes`, from the first whole line in them, in place:
 * launchd holds it open for appending, so it cannot be replaced.
 */
export function truncateLog(path: string, bytes = UPDATE_LOG_BYTES) {
  let fd: number;
  try {
    fd = openSync(path, 'r+');
  } catch (error) {
    // Nothing written yet, nothing to cut.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // Everything through this one descriptor: the path could name another file
  // by the time the bytes are read back or written.
  try {
    const size = fstatSync(fd).size;
    if (size <= bytes) return;
    const tail = Buffer.alloc(bytes);
    readSync(fd, tail, 0, bytes, size - bytes);
    const newline = tail.indexOf('\n');
    const kept = newline === -1 ? tail : tail.subarray(newline + 1);
    writeSync(fd, kept, 0, kept.length, 0);
    ftruncateSync(fd, kept.length);
  } finally {
    closeSync(fd);
  }
}

/**
 * One update; the exit status. A skip is not a failure. `nixLog` reads the bytes
 * of the build's stderr, which only a `--progress` run asks nix to write.
 */
export async function update(config: Config, report: Report = plain, nixLog?: NixLog): Promise<number> {
  const { state, history, nix } = config;
  mkdirSync(state, { recursive: true });
  const current = currentLink(state);
  // Empty before the first run.
  const old = lstatSync(current, { throwIfNoEntry: false }) ? realpath(current) : '';
  const record = (event: string) => appendHistory(history, historyLine(event));
  // A skipped update is not a failure: exiting 0 avoids the pointless restart
  // loop, and last-success stays untouched so launchd tries again next hour.
  // Repeats of the same reason are logged once.
  const skip = (reason: string) => {
    report.note('warn', `update skipped: ${reason}`);
    report.result({ result: 'skipped', reason });
    const lines = existsSync(history) ? readFileSync(history, 'utf8').split('\n') : [];
    if (lines.at(-1) === '') lines.pop();
    if ((lines.at(-1) ?? '').split(' ').slice(1).join(' ') !== `skipped: ${reason}`) record(`skipped: ${reason}`);
    return 0;
  };

  const caches = checkCaches(nix, config.substituters);
  const usable = caches.filter((cache) => cache.usable);
  const unusable = caches.filter((cache) => !cache.usable);
  // Some cache is configured and nix will not honour any of it: the signed
  // package is out of reach for this user, so the content-addressed one is the
  // only path left (contentAddressed), and a skip when it is not published.
  const adrift = unusable.length > 0 && usable.length === 0;
  const options = usable.length
    ? ['--option', 'extra-substituters', usable.map((cache) => cache.url).join(' '),
      '--option', 'extra-trusted-public-keys', usable.map((cache) => cache.key).join(' ')]
    : [];

  // Lock once so the dry run and the build see the same revision. The stderr
  // is piped (not inherited) so a failure can name nix's own error; it is
  // re-emitted unchanged.
  log.update.debug(`running ${nix} flake metadata --refresh --json ${config.flake}`);
  const metadata = spawnSync(nix, ['flake', 'metadata', '--refresh', '--json', config.flake],
    { ...UNBOUNDED, stdio: ['inherit', 'pipe', 'pipe'] });
  process.stderr.write(metadata.stderr);
  let ref = '';
  // What the index keys a package by; a path flake has none.
  let revision = '';
  try {
    if (metadata.status === 0) {
      const resolved = JSON.parse(metadata.stdout);
      ref = resolved.url ?? '';
      revision = typeof resolved.revision === 'string' ? resolved.revision : '';
    }
  } catch (error) {
    log.update.warn(`nix flake metadata printed unreadable JSON: ${(error as Error).message}`);
    ref = '';
  }

  // Read versions before either path replaces the current out-link.
  const previous = old ? versions(old) : null;
  let build: Build;
  if (adrift) {
    const outcome = await contentAddressed(config, report, nixLog,
      unusable.map((cache) => cache.url), revision, current);
    if ('skip' in outcome) return skip(outcome.skip);
    build = outcome.build;
  } else {
    if (typeof ref !== 'string' || !ref) {
      const detail = nixErrorDetail(metadata.stderr);
      // Under `--progress` the JSON result carries the cause; the plain note appends it.
      const suffix = !nixLog && detail ? `: ${detail}` : '';
      report.note('error', `update failed (cannot resolve ${config.flake})${suffix}`);
      record('failed: cannot resolve flake');
      report.result({ result: 'failed', reason: 'cannot resolve flake', ...(detail ? { detail } : {}) });
      return 1;
    }
    const target = `${ref}#${config.attribute ?? ATTRIBUTE}`;
    // Never compile on a cache miss, nor when what would be built is unknown.
    const plan = wouldCompile(nix, target, options);
    if ('unknown' in plan) return skip(`cannot tell what the package would build (${plan.unknown})`);
    if (plan.names) return skip(`package not fully cached yet (would build ${plan.names})`);
    const args = ['build', target, ...options, '--out-link', current];
    log.update.debug(`running ${nix} ${args.join(' ')}`);
    build = await nixStep(nix, args, nixLog, report);
  }
  if (build.error || build.status !== 0) {
    // As bash reports it: 127 for a nix that is gone (say, garbage-collected),
    // 126 for one that cannot run, a signal's number plus 128.
    const code = (build.error as NodeJS.ErrnoException | undefined)?.code;
    const status = build.error ? (code === 'ENOENT' ? 127 : 126)
      : build.status ?? 128 + (constants.signals[build.signal!] ?? 0);
    if (build.error) report.note('error', `cannot run ${nix}: ${build.error.message}`);
    report.note('error', `update failed (exit ${status})`);
    record(`failed: nix build exit ${status}`);
    const detail = nixLog?.errorDetail ?? null;
    report.result({ result: 'failed', reason: `nix build exit ${status}`, ...(detail ? { detail } : {}) });
    return status;
  }
  const next = realpath(current);
  writeFileSync(`${lastSuccessFile(state)}.tmp`, `${Math.floor(Date.now() / 1000)}\n`);
  renameSync(`${lastSuccessFile(state)}.tmp`, lastSuccessFile(state));
  if (next === old) {
    report.summary(`unchanged (${next})`);
    report.result({ result: 'unchanged', package: next });
  } else {
    record(`updated: ${changes(previous, versions(next))}`);
    report.summary(`updated ${old || 'nothing'} -> ${next}`);
    report.result({ result: 'updated', package: next });
  }
  return 0;
}

/** When due, up to SCHEDULED_ATTEMPTS attempts, SCHEDULED_RETRY_SECONDS apart (src/update/due.ts). */
async function scheduled(config: Config): Promise<number> {
  try {
    truncateLog(join(config.state, 'update.log'));
  } catch (error) {
    log.update.warn(`cannot trim ${join(config.state, 'update.log')}: ${(error as Error).message}`);
  }
  let stamp: number | null = null;
  try {
    stamp = parseStamp(readFileSync(lastSuccessFile(config.state), 'utf8'));
  } catch {
    stamp = null;
  }
  if (!updateDue(Math.floor(Date.now() / 1000), stamp, config.periodSeconds, config.offsetSeconds)) return 0;
  for (let attempt = 1; ; attempt++) {
    let status: number;
    try {
      status = await update(config);
    } catch (error) {
      log.update.error(`update failed: ${error instanceof Error ? error.message : String(error)}`);
      log.update.debug(error instanceof Error ? error.stack ?? error.message : String(error));
      status = 1;
    }
    if (status === 0) return 0;
    if (attempt === SCHEDULED_ATTEMPTS) return 1;
    log.update.warn(`attempt ${attempt} of ${SCHEDULED_ATTEMPTS} failed; retrying in ${SCHEDULED_RETRY_SECONDS / 60} minutes`);
    await sleep(SCHEDULED_RETRY_SECONDS * 1000);
  }
}

/**
 * Warn about the caches this user's nix will not honour. What an unusable
 * cache costs depends on the others: with a usable one the update proceeds
 * through it, and only with none — the same test `update` makes — does it take
 * the published content-addressed package, and skip where none is published.
 */
function cacheWarnings(config: Config): number {
  const caches = checkCaches(config.nix, config.substituters);
  const usable = caches.some((cache) => cache.usable);
  for (const cache of caches) {
    if (cache.usable) continue;
    log.update.warn(`cannot use cache ${cache.url}; `
      + (usable
        ? 'updates use the caches nix will honour. '
        : 'updates fetch the content-addressed package instead, and skip where none is published for the revision. ')
      + 'Add it to nix.settings substituters and trusted-public-keys.');
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
