/**
 * The Antigravity CLI's side of a launch's plugins.
 *
 * Usage: node agy.ts link FLOCK SESSION_PID WANTED_JSON
 *
 * Google documents no flag that loads a plugin for one launch: it documents
 * `~/.gemini/config/plugins/` as where `agy` reads plugin folders, a directory
 * the Antigravity desktop app and IDE read too. So `adapter.translate` writes
 * each plugin as an Antigravity plugin folder — `plugin.json`, `skills/`, and
 * `mcp_config.json`, whose stdio servers run through generated launchers
 * (src/plugin/resources.ts) — and `adapter.launch` prints which plugin names
 * this launch wants, and from which translation. The launcher then runs
 * `link`, which puts each into that directory (`ENTRIES`) before it `exec`s
 * `agy` as SESSION_PID.
 *
 * What is agent-distro's there is known by the entry itself — it was placed
 * from a translation in agent-distro's cache (src/plugin/launch.ts) — never by
 * a record that could disagree with it, so a launch killed at any point leaves
 * nothing the next one takes for the user's. An entry that is not ours is never
 * altered or removed; a plugin whose name one already holds is skipped, with a
 * word.
 *
 * Which launches still use an entry is kept out of Google's directory, in
 * `~/.local/state/agent-distro/agy-launches`: one claim per launch,
 * `<pid>.json`, naming the entries its session uses, which counts for as long
 * as that process — the launcher, then `agy` in its place — runs. That
 * directory comes from HOME alone, as the plugins directory does, never from
 * XDG_STATE_HOME: every launch that can write one home's plugins finds the
 * same claims and lock, and a claim names no directory, so two spellings of
 * one home (a symlink and its target) are one. A launch removes an entry of
 * ours only when no running launch claims it, and two launches never do this
 * at once: `link` runs under an exclusive lock on `lock` beside the claims,
 * which the operating system releases when a launch dies. A launch writes its
 * claim before it changes the directory, so one that cannot claim changes
 * nothing. Of two running launches that want different translations under one
 * name, the later keeps the one already there, and says so.
 *
 * A home that is unset or cannot be written skips all of this, saying what
 * failed, and `agy` still starts.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.ts';
import { hold, release, type Adapter, type Holder, type Report } from '../plugin/launch.ts';
import type { ModelSource } from '../models.ts';
import type { Description } from '../plugin/read.ts';
import { copySkills, launchable, writeLauncher, type Inputs } from '../plugin/resources.ts';
import { isSystemError, lexists, processIdentity, writeTemporary } from '../util.ts';

/** Antigravity's own manifest schema: the folder is an Antigravity plugin, not an Agent Plugins one. */
const SCHEMA = 'https://antigravity.google/schemas/v1/plugin.json';

/**
 * The `name` pattern of the schema `SCHEMA` names (letters, digits, `-`, `_`);
 * Agent Plugins also allows `.`, which it refuses.
 */
const ANTIGRAVITY_NAME = /^[a-zA-Z0-9_-]+$/;

/** Plugin name → the translation its entry is placed from. */
type Links = Record<string, string>;

/**
 * One launch's claim: the entries its session uses while process `pid` runs.
 * It names no directory: a claims directory serves exactly one plugins
 * directory (`locations`), however either is spelled.
 */
type Claim = { pid: number; identity: string; links: Links };

/** How long a launch waits for another to finish linking before it skips its own links. */
const LOCK_SECONDS = 30;

const logger = log.harness('agy');

/**
 * One home's plugins directory, `~/.gemini/config/plugins`, and the claims and
 * lock that guard it, or null without a home. Both come from HOME alone, so
 * two launches share the claims exactly when they share the directory.
 */
export function locations(env: NodeJS.ProcessEnv = process.env): { plugins: string; claims: string } | null {
  if (!env.HOME) return null;
  return {
    plugins: join(env.HOME, '.gemini', 'config', 'plugins'),
    claims: join(env.HOME, '.local', 'state', 'agent-distro', 'agy-launches'),
  };
}

/**
 * One plugin as an Antigravity plugin folder at `out`. Its manifest's fields
 * are all in Antigravity's manifest schema, but that schema's `name` pattern
 * allows no `.`, and an SSE server is skipped: Antigravity's remote servers
 * are Streamable HTTP only.
 */
export function writeAntigravityPlugin(description: Description, out: string, { bash, env }: Inputs, report: Report) {
  mkdirSync(out, { recursive: true });
  const { name } = description.manifest;
  if (!ANTIGRAVITY_NAME.test(name)) {
    report(`plugin.json: name ${JSON.stringify(name)} is not one Antigravity's manifest schema allows; whether agy loads it is unproven`);
  }
  writeFileSync(join(out, 'plugin.json'), JSON.stringify({ ...description.manifest, $schema: SCHEMA }, null, 2) + '\n');
  copySkills(description, join(out, 'skills'));
  const servers: Record<string, unknown> = {};
  Object.entries(description.mcpServers).forEach(([server, entry], index) => {
    let reason: string | null = null;
    if (entry.type === 'sse') {
      reason = 'Antigravity does not support SSE';
    } else if (entry.type === 'stdio') {
      if (!launchable(description, entry)) {
        reason = 'the adapter cannot launch a command containing "="';
      } else {
        servers[server] = { command: writeLauncher(description, server, entry, out, index, bash, env), args: [] };
      }
    } else {
      servers[server] = { serverUrl: entry.url, headers: entry.headers };
    }
    if (reason) report(`mcp.json: server ${JSON.stringify(server)} skipped, ${reason}`);
  });
  if (Object.keys(servers).length) {
    writeFileSync(join(out, 'mcp_config.json'), JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
  }
}

/** A translation for this adapter, as src/plugin/launch.ts lays out its cache. */
const TRANSLATION = /^\/.*\/agent-distro\/plugins\/[^/]+\/agy\/[^/]+\/out$/;

/**
 * How a translation is put where `agy` reads plugins, and how an entry of ours
 * is known again: the one place that decides between a link and a copy. A
 * link to a translation in agent-distro's cache is ours by its target alone.
 * Exported so a check can make one placement fail.
 */
export const ENTRIES = {
  /** The translation the entry at `path` was placed from, or null when it is not ours or not there. */
  source(path: string): string | null {
    let target: string;
    try {
      if (!lstatSync(path).isSymbolicLink()) return null;
      target = readlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return TRANSLATION.test(target) ? target : null;
  },
  /** Place `translation` at `path`, atomically; false when something is there already. */
  place(translation: string, path: string): boolean {
    try {
      symlinkSync(translation, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  },
  remove(path: string) {
    rmSync(path);
  },
};

/** A plugin name as a path component: one, and inside the directory. */
const isName = (name: string) => name !== '' && name !== '.' && name !== '..' && !name.includes('/');

function isClaim(value: unknown): value is Claim {
  const claim = value as Claim | null;
  return typeof claim === 'object' && claim !== null && Number.isInteger(claim.pid)
    && typeof claim.identity === 'string'
    && typeof claim.links === 'object' && claim.links !== null && !Array.isArray(claim.links)
    && Object.entries(claim.links).every(([name, target]) => isName(name) && typeof target === 'string' && TRANSLATION.test(target));
}

/**
 * A launch that leaves the plugins directory as it found it, or stops partway
 * with what it placed already claimed; the message says which, and what
 * failed.
 */
export class Skipped extends Error {}

/** Run `body`, turning an operating-system error into `Skipped`, with `what` first. */
function step<T>(what: string, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (isSystemError(error)) throw new Skipped(`${what}: ${error.message}`);
    throw error;
  }
}

/**
 * Every translation a running launch other than `self` claims, by plugin
 * name: two running launches can claim different translations under one name
 * (one placed after the user removed the other's entry), and each counts. A
 * claim whose process has ended is removed; one that is not a claim is
 * removed too, with a word.
 */
function liveClaims(claims: string, self: number): Map<string, Set<string>> {
  const held = new Map<string, Set<string>>();
  for (const file of readdirSync(claims)) {
    if (!file.endsWith('.json')) continue;
    const path = join(claims, file);
    let claim: unknown;
    try {
      claim = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (isSystemError(error) && error.code === 'ENOENT') continue;
      if (isSystemError(error)) throw error;
    }
    if (!isClaim(claim)) {
      logger.warn(`${path} is not a launch's claim; removing it`);
      rmSync(path, { force: true });
      continue;
    }
    if (claim.pid === self) continue;
    if (processIdentity(claim.pid) !== claim.identity) {
      for (const target of Object.values(claim.links)) release(target, claim.pid);
      rmSync(path, { force: true });
      continue;
    }
    for (const [name, target] of Object.entries(claim.links)) {
      if (!held.has(name)) held.set(name, new Set());
      held.get(name)!.add(target);
    }
  }
  return held;
}

function writeClaim(claims: string, claim: Claim) {
  // Only a launch holding the lock writes here, so a temporary file is one an
  // interrupted launch left.
  for (const file of readdirSync(claims)) if (file.startsWith('.claim-')) rmSync(join(claims, file), { force: true });
  const path = join(claims, `${claim.pid}.json`);
  if (!Object.keys(claim.links).length) {
    rmSync(path, { force: true });
    return;
  }
  const temporary = writeTemporary(claims, '.claim-', JSON.stringify(claim, null, 2) + '\n');
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Put `wanted` in `directory` for `session`, and take back every entry of ours
 * no running launch claims. Run under the lock (`link`). Returns what this
 * session claims.
 *
 * The claim is written before the directory changes, naming everything this
 * launch will use: a launch that cannot claim places nothing and takes nothing
 * back, and one that stops while changing the directory has claimed whatever
 * it placed. A claimed entry that is then not placed harms nothing. Throws
 * `Skipped`, saying what failed.
 */
export function settle(directory: string, claims: string, session: Holder, wanted: Links, report: Report): Links {
  const unchanged = 'nothing placed or taken back';
  const held = step(`cannot read the claims in ${claims}; ${unchanged}`, () => {
    mkdirSync(claims, { recursive: true });
    return liveClaims(claims, session.pid);
  });
  // What this launch will use, decided before anything changes.
  const using: Links = {};
  const entries = step(`cannot read ${directory}; ${unchanged}`, () => {
    for (const [name, translation] of Object.entries(wanted)) {
      const path = join(directory, name);
      const source = ENTRIES.source(path);
      if (source !== null && source !== translation && held.get(name)?.has(source)) {
        report(`plugin ${JSON.stringify(name)}: another running agy launch placed another translation of it; this launch uses that one`);
        using[name] = source;
      } else if (source === null && lexists(path)) {
        report(`plugin ${JSON.stringify(name)} skipped: ${path} is not agent-distro's`);
      } else {
        using[name] = translation;
      }
    }
    return lexists(directory) ? readdirSync(directory) : [];
  });
  step(`cannot write this launch's claim in ${claims}; ${unchanged}`,
    () => writeClaim(claims, { ...session, links: using }));
  // A session can outlive any launch that uses its translations: held, they
  // are not pruned from the cache while it runs (src/plugin/launch.ts `prune`).
  step(`cannot hold this launch's translations in the cache; ${unchanged}`, () => {
    for (const translation of Object.values(using)) hold(translation, session);
  });
  step(`cannot change ${directory}; what this launch placed before that is claimed`, () => {
    for (const name of entries) {
      const path = join(directory, name);
      const source = ENTRIES.source(path);
      if (source !== null && using[name] !== source && !held.get(name)?.has(source)) ENTRIES.remove(path);
    }
    for (const [name, translation] of Object.entries(using)) {
      const path = join(directory, name);
      if (ENTRIES.source(path) === translation) continue;
      mkdirSync(directory, { recursive: true });
      if (!ENTRIES.place(translation, path)) report(`plugin ${JSON.stringify(name)} skipped: ${path} is not agent-distro's`);
    }
  });
  return using;
}

/**
 * `agy models`: one model a line, its slug, a tab, and its name. That is what
 * `agy` prints when its output is not a terminal, which is how the launcher
 * always runs it. Google's documentation shows the lines with spaces between
 * slug and name, which `agy` was not seen to print; the reader refuses them
 * rather than guess. The slug is what `--model` takes. Any other line is
 * refused, not guessed at.
 */
const MODEL_LINE = /^([a-z0-9][a-z0-9._-]*)\t\S/;

export const models: ModelSource = {
  launch: { kind: 'flag', flag: '--model' },
  list: {
    args: ['models'],
    read: (stdout) => {
      const lines = stdout.split('\n').map((line) => line.trimEnd()).filter(Boolean);
      if (!lines.length) throw new Error('no models, and no word why');
      return lines.map((line) => {
        const match = MODEL_LINE.exec(line);
        if (!match) throw new Error(`${JSON.stringify(line)}, not a model's slug and name`);
        return match[1];
      });
    },
  },
};

/** At launch: the plugins this launch wants placed, by name, for `link`; nothing on agy's command line. */
export const adapter: Adapter<Inputs, Inputs> = {
  translationInputs: ({ bash, env }) => ({ bash, env }),
  translate: (description, out, inputs, report) => writeAntigravityPlugin(description, out, inputs, report),
  launch: ({ plugins }) => JSON.stringify(Object.fromEntries(plugins.map((plugin) => [plugin.name, plugin.translation]))),
};

/**
 * `link`: `settle` for the session, under the lock; `settle-locked` is what it
 * runs there. Every failure is a warning: the harness still starts.
 */
function run(argv: string[]): number {
  const [command, ...rest] = argv;
  const where = locations();
  if (command === 'link') {
    const [flock, pid, wanted] = rest;
    const any = Object.keys(JSON.parse(wanted)).length > 0;
    if (!where) {
      if (any) logger.warn('HOME is unset; skipping plugin links');
      return 0;
    }
    const { claims } = where;
    try {
      mkdirSync(claims, { recursive: true });
    } catch (error) {
      if (!isSystemError(error)) throw error;
      // Nothing wanted: nothing to place, and nothing is taken back without the claims.
      if (any) logger.warn(`cannot create ${claims}: ${error.message}; nothing placed or taken back`);
      return 0;
    }
    const lock = join(claims, 'lock');
    const locked = spawnSync(flock, ['-w', String(LOCK_SECONDS), lock,
      process.execPath, import.meta.filename, 'settle-locked', pid, wanted], { stdio: 'inherit' });
    if (locked.status !== 0) {
      logger.warn(`plugin links skipped: another agy launch held ${lock} for ${LOCK_SECONDS}s, or linking failed above`);
    }
    return 0;
  }
  if (command !== 'settle-locked') throw new Error(`unknown command: ${command}`);
  const pid = Number(rest[0]);
  const identity = processIdentity(pid);
  if (identity === null) {
    logger.warn(`session ${rest[0]} has already ended; nothing placed or taken back`);
    return 0;
  }
  try {
    settle(where!.plugins, where!.claims, { pid, identity }, JSON.parse(rest[1]), (message) => logger.warn(message));
  } catch (error) {
    if (!(error instanceof Skipped)) throw error;
    logger.warn(error.message);
  }
  return 0;
}

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
