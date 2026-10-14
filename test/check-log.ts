/**
 * src/log.ts without a terminal: the line format with and without a TTY,
 * NO_COLOR, every level AGENT_DISTRO_LOG accepts and the fallback for one it
 * does not, the journal's priority prefix, escaping, tags, and `slow`.
 *
 * Usage: node check-log.ts SRC
 */
import assert from 'node:assert/strict';
import { closeSync, fstatSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { WriteStream } from 'node:tty';

const [src] = process.argv.slice(2);
const { createLogger, isJournal, slow, LEVELS, NOTICE_MS } = await import(join(src, 'log.ts'));

/** A stream that keeps what is written, a terminal when `tty`. */
function sink(tty = false) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  }) as Writable & { isTTY?: boolean; getColorDepth?: (env?: NodeJS.ProcessEnv) => number };
  if (tty) {
    stream.isTTY = true;
    // What a real terminal answers, from the same environment.
    stream.getColorDepth = (env) => WriteStream.prototype.getColorDepth.call(stream, env);
  }
  return { stream, text: () => chunks.join('') };
}

/** Every severity, once, through a logger made for `env`. */
function everything(env: NodeJS.ProcessEnv, options: Record<string, unknown> = {}) {
  const { stream, text } = sink();
  const log = createLogger({ stream, env, ...options });
  log.profile.error('e');
  log.profile.warn('w');
  log.profile.info('i');
  log.profile.debug('d');
  log.profile.trace('t');
  return text();
}

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;
delete process.env.NODE_DISABLE_COLORS;
process.env.TERM = 'xterm-256color';

test('without a terminal: a plain severity word after the tag, no escapes', () => {
  assert.equal(everything({}), [
    'agent-distro profile: error: e',
    'agent-distro profile: warning: w',
    'agent-distro profile: i',
    '',
  ].join('\n'));
});

test('on a terminal: the severity colored, NO_COLOR honoured', () => {
  const { stream, text } = sink(true);
  createLogger({ stream, env: {} }).plugin.warn('careful');
  assert.match(text(), /^agent-distro plugin: \x1b\[33mwarning:\x1b\[39m careful\n$/);
  process.env.NO_COLOR = '1';
  try {
    const plain = sink(true);
    createLogger({ stream: plain.stream, env: {} }).plugin.warn('careful');
    assert.equal(plain.text(), 'agent-distro plugin: warning: careful\n');
  } finally {
    delete process.env.NO_COLOR;
  }
});

test('each level shows itself and everything more severe', () => {
  const lines = (level: string) => everything({ AGENT_DISTRO_LOG: level }).split('\n').filter(Boolean)
    .map((line) => line.slice(-1));
  assert.deepEqual(lines('silent'), []);
  assert.deepEqual(lines('error'), ['e']);
  assert.deepEqual(lines('warn'), ['e', 'w']);
  assert.deepEqual(lines('info'), ['e', 'w', 'i']);
  assert.deepEqual(lines('debug'), ['e', 'w', 'i', 'd']);
  assert.deepEqual(lines('trace'), ['e', 'w', 'i', 'd', 't']);
  assert.deepEqual(lines(''), ['e', 'w', 'i']);
  assert.deepEqual(LEVELS, ['silent', 'error', 'warn', 'info', 'debug', 'trace']);
});

test('an unknown level is info, with one warning, and is named for the processes this one starts', () => {
  const text = everything({ AGENT_DISTRO_LOG: 'loud' });
  assert.equal(text.split('\n')[0], 'agent-distro: warning: unknown AGENT_DISTRO_LOG=loud; using info '
    + '(silent, error, warn, info, debug, trace)');
  assert.equal(text.split('\n').filter((line) => line.includes('unknown')).length, 1);
  assert.ok(text.includes('agent-distro profile: i\n') && !text.includes(': d\n'), text);
  const { stream } = sink();
  assert.equal(createLogger({ stream, env: { AGENT_DISTRO_LOG: 'loud' } }).unknown, 'loud');
  assert.equal(createLogger({ stream, env: { AGENT_DISTRO_LOG: 'debug' } }).unknown, null);
  assert.equal(createLogger({ stream, env: {} }).unknown, null);
});

test('on the journal: each line starts with its sd-daemon priority', () => {
  assert.equal(everything({ AGENT_DISTRO_LOG: 'debug' }, { journal: true }), [
    '<3>agent-distro profile: error: e',
    '<4>agent-distro profile: warning: w',
    '<6>agent-distro profile: i',
    '<7>agent-distro profile: d',
    '',
  ].join('\n'));
  const { stream, text } = sink();
  createLogger({ stream, env: {}, journal: true }).update.error('one\ntwo');
  assert.equal(text(), '<3>agent-distro update: error: one\n<3>two\n');
});

test('JOURNAL_STREAM counts only when it names the stream itself', () => {
  const fd = openSync(join(mkdtempSync(join(tmpdir(), 'log-')), 'journal'), 'w');
  try {
    const { dev, ino } = fstatSync(fd, { bigint: true });
    assert.equal(isJournal({ JOURNAL_STREAM: `${dev}:${ino}` }, fd), true);
    assert.equal(isJournal({ JOURNAL_STREAM: `${dev}:${ino + 1n}` }, fd), false);
    assert.equal(isJournal({ JOURNAL_STREAM: 'nonsense' }, fd), false);
    assert.equal(isJournal({}, fd), false);
  } finally {
    closeSync(fd);
  }
});

test('control characters are escaped once, in the reporter; newlines and tabs stay', () => {
  const { stream, text } = sink();
  createLogger({ stream, env: {} }).plugin.warn('a\x1b]0;title\x07b\tc');
  assert.equal(text(), 'agent-distro plugin: warning: a\\x1b]0;title\\x07b\tc\n');
});

test('tags name the component; the root has none; repeats are never folded', () => {
  const { stream, text } = sink();
  const log = createLogger({ stream, env: {} });
  for (const tag of ['profile', 'update', 'gateway', 'picker', 'plugin', 'claude', 'codex', 'omp', 'opencode', 'pi']) {
    log[tag].info('x');
  }
  log.harness('muse').info('x');
  log.root.info('x');
  for (let i = 0; i < 8; i++) log.update.info('again');
  const lines = text().split('\n').filter(Boolean);
  assert.deepEqual(lines.slice(0, 12), [
    'profile', 'update', 'gateway', 'picker', 'plugin', 'claude', 'codex', 'omp', 'opencode', 'pi', 'muse',
  ].map((tag) => `agent-distro ${tag}: x`).concat('agent-distro: x'));
  assert.equal(lines.filter((line) => line === 'agent-distro update: again').length, 8);
});

test('slow: a synchronous call says so first, and its time at debug', () => {
  const { stream, text } = sink();
  const log = createLogger({ stream, env: { AGENT_DISTRO_LOG: 'debug' } });
  const result = slow(log.profile, 'evaluating /p/agent-distro.nix', () => {
    assert.equal(text(), 'agent-distro profile: evaluating /p/agent-distro.nix …\n');
    return 42;
  });
  assert.equal(result, 42);
  assert.match(text().split('\n')[1], /^agent-distro profile: evaluating \/p\/agent-distro\.nix: done in \d+\.\ds$/);
  const quiet = sink();
  slow(createLogger({ stream: quiet.stream, env: {} }).profile, 'building', () => 0);
  assert.equal(quiet.text(), 'agent-distro profile: building …\n');
});

test('slow: an async call says so only once it has taken NOTICE_MS', async () => {
  const { stream, text } = sink();
  const log = createLogger({ stream, env: {} });
  assert.equal(await slow(log.gateway, 'quick', async () => 'q'), 'q');
  assert.equal(text(), '');
  await slow(log.gateway, 'waiting', async () => new Promise((resolve) => setTimeout(resolve, NOTICE_MS + 200)));
  assert.equal(text(), 'agent-distro gateway: waiting …\n');
});

test('slow: a plain function returning a promise is timed as it settles', async () => {
  const { stream, text } = sink();
  const log = createLogger({ stream, env: { AGENT_DISTRO_LOG: 'debug' } });
  const answer = Promise.withResolvers<string>();
  const settled = slow(log.gateway, 'asking', () => answer.promise);
  assert.equal(text(), 'agent-distro gateway: asking …\n');
  setTimeout(() => answer.resolve('a'), 50);
  assert.equal(await settled, 'a');
  assert.match(text().split('\n')[1], /^agent-distro gateway: asking: done in 0\.\ds$/);
});

test("slow: notice 'debug' records only the time taken", () => {
  const { stream, text } = sink();
  assert.equal(slow(createLogger({ stream, env: {} }).gateway, 'discovering', () => 1, 'debug'), 1);
  assert.equal(text(), '');
  const loud = sink();
  slow(createLogger({ stream: loud.stream, env: { AGENT_DISTRO_LOG: 'debug' } }).gateway, 'discovering', () => 1, 'debug');
  assert.equal(loud.text().split('\n')[0], 'agent-distro gateway: discovering …');
});
