/**
 * Every message agent-distro prints for a person, on stderr.
 *
 * One consola instance, from `consola/core` alone: the package's default entry
 * writes info lines to stdout, colors by stdout's TTY state and loads a fancy
 * reporter and prompts at start-up, and stdout here is a protocol channel (the
 * shell launch.ts prints for eval, the JSON of `--list --json`, the path a
 * harness config writer prints). The one reporter writes every level to stderr as
 *
 *   agent-distro <tag>: <message>
 *   agent-distro <tag>: warning: <message>
 *   agent-distro <tag>: error: <message>
 *
 * colored on a terminal by `util.styleText`, which honours NO_COLOR,
 * FORCE_COLOR and the stream's TTY state, and plain words otherwise. When
 * stderr is the journal (JOURNAL_STREAM names it, as systemd sets it for a
 * service), each line starts with its sd-daemon priority, so `journalctl -p
 * warning` filters. Every message passes through `printable` here, once: a
 * call site never escapes text that only reaches stderr.
 *
 * AGENT_DISTRO_LOG sets the level: silent, error, warn, info (the default),
 * debug or trace. The tag names the component; `log.<tag>` is its logger. A
 * value no level matches warns once and falls back to info; `unknown` holds it
 * so a process that starts others can pass them the level it settled on
 * instead of having each repeat that warning.
 *
 * `slow` wraps work that can keep a person waiting. Nearly everything here is
 * synchronous (spawnSync), and a timer cannot interrupt a synchronous call to
 * say it is taking long, so for a synchronous `fn` the start line is printed
 * before it runs: call sites wrap only work known to be slow, once a cache has
 * missed (an evaluation not cached, a reference not in the store, a build
 * the dry run found in the cache). Work that is bounded and runs every launch
 * passes `notice: 'debug'` instead, which only records the time taken.
 * An `async` function gets the start line only if it has not settled after
 * NOTICE_MS; a plain function returning a promise is timed as it settles.
 * Either way the time taken is logged at debug.
 */
import { fstatSync } from 'node:fs';
import { formatWithOptions, styleText } from 'node:util';
import { createConsola, type ConsolaInstance, type LogObject } from 'consola/core';
import { printable } from './util.ts';

export type Logger = ConsolaInstance;

/** The levels AGENT_DISTRO_LOG accepts, quietest first. */
export const LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type Level = typeof LEVELS[number];

export const VARIABLE = 'AGENT_DISTRO_LOG';

/** agent-distro's website, named by the one line a plain launch prints. */
export const SITE = 'https://agent-distro.nixos.asia';

/** How long an `async` slow operation runs before its start line is printed. */
export const NOTICE_MS = 400;

type Stream = NodeJS.WritableStream & { isTTY?: boolean };

export type Options = {
  stream?: Stream;
  env?: NodeJS.ProcessEnv;
  /** Prefix each line with its sd-daemon priority; by default, when stderr is the journal. */
  journal?: boolean;
};

/** Whether `fd` is the journal stream systemd names in JOURNAL_STREAM (`device:inode`). */
export function isJournal(env: NodeJS.ProcessEnv, fd = 2): boolean {
  const [device, inode] = (env.JOURNAL_STREAM ?? '').split(':');
  if (!device || !inode) return false;
  try {
    const stat = fstatSync(fd, { bigint: true });
    return String(stat.dev) === device && String(stat.ino) === inode;
  } catch {
    return false;
  }
}

type Severity = 'error' | 'warning' | 'info' | 'debug';

function severity(type: string): Severity {
  if (type === 'error' || type === 'fatal') return 'error';
  if (type === 'warn') return 'warning';
  if (type === 'debug' || type === 'trace' || type === 'verbose') return 'debug';
  return 'info';
}

const PRIORITY: Record<Severity, number> = { error: 3, warning: 4, info: 6, debug: 7 };

/** One log line, or several for a multi-line message, as the reporter writes them. */
export function format(object: Pick<LogObject, 'type' | 'tag' | 'args'>, stream: Stream, journal: boolean): string {
  const level = severity(object.type);
  const text = printable(formatWithOptions({ colors: false }, ...object.args));
  // On the journal, never escapes: it is a socket, and journalctl colors by priority.
  const style = (format: Parameters<typeof styleText>[0], value: string) =>
    journal ? value : styleText(format, value, { stream, validateStream: true });
  const word = level === 'error' ? style('red', 'error:') + ' '
    : level === 'warning' ? style('yellow', 'warning:') + ' ' : '';
  const body = level === 'debug' ? style('dim', text) : text;
  const line = `agent-distro${object.tag ? ' ' + object.tag : ''}: ${word}${body}`;
  const lines = line.split('\n');
  return (journal ? lines.map((l) => `<${PRIORITY[level]}>${l}`) : lines).join('\n') + '\n';
}

/**
 * A root logger and its tagged children, writing to `stream` at the level
 * `env` asks for. The process's own is `log`; tests make their own.
 */
export function createLogger({ stream = process.stderr, env = process.env, journal }: Options = {}) {
  const toJournal = journal ?? (stream === process.stderr && isJournal(env));
  const asked = env[VARIABLE];
  const level: Level = asked === undefined || asked === '' ? 'info'
    : (LEVELS as readonly string[]).includes(asked) ? asked as Level : 'info';
  // The value this process could not use, for a caller that passes the level
  // on to the processes it starts, so they do not repeat the warning below.
  const unknown = asked && level !== asked ? asked : null;
  const root = createConsola({
    level: level === 'silent' ? -1 : level,
    // Every message, even a repeated one: consola otherwise folds repeats.
    throttle: 0,
    reporters: [{ log: (object) => void stream.write(format(object, stream, toJournal)) }],
  });
  if (unknown) root.warn(`unknown ${VARIABLE}=${unknown}; using info (${LEVELS.join(', ')})`);
  const tag = (name: string) => root.withTag(name);
  return {
    root,
    level,
    unknown,
    profile: tag('profile'),
    update: tag('update'),
    picker: tag('picker'),
    plugin: tag('plugin'),
    claude: tag('claude'),
    codex: tag('codex'),
    omp: tag('omp'),
    opencode: tag('opencode'),
    pi: tag('pi'),
    /** A harness's logger, by adapter name; a harness without one of its own gets one. */
    harness: tag,
  };
}

export const log = createLogger();

const AsyncFunction = (async () => {}).constructor;

const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)}s`;

const thenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';

/**
 * Run `fn`, telling a person waiting on it what it is; see the head of this
 * file. `notice` is the level of that line: `debug` for work that is bounded
 * and runs on every launch, where only the time taken is worth recording.
 */
export function slow<T>(logger: Logger, label: string, fn: () => T, notice: 'info' | 'debug' = 'info'): T {
  const since = performance.now();
  const start = () => notice === 'info' ? logger.start(`${label} …`) : logger.debug(`${label} …`);
  const done = () => logger.debug(`${label}: done in ${seconds(since)}`);
  // Only an `async` function can be left to the timer: a synchronous call
  // blocks the loop, so nothing could print its notice while it runs.
  const timer = fn instanceof AsyncFunction ? setTimeout(start, NOTICE_MS) : (start(), undefined);
  const result = fn();
  // A plain function may still return a promise: time what it returned.
  if (!thenable(result)) {
    clearTimeout(timer);
    done();
    return result;
  }
  return Promise.resolve(result).finally(() => {
    clearTimeout(timer);
    done();
  }) as T;
}
