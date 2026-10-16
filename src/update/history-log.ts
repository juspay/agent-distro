/**
 * The history log's one writer: append a line (`./history.ts`' `historyLine`)
 * and keep the log to about its last HISTORY_LINES lines. Every program that
 * writes the log — the updater, and any consumer that records its own runs
 * there (kolu) — appends through this, so the log never grows without bound
 * and a trim never drops another writer's line.
 */
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeTemporary } from '../util.ts';

/** The history log keeps this many lines, the newest. */
export const HISTORY_LINES = 1000;
/**
 * Trimming rewrites the whole file, so it waits until there is this much per
 * line to rewrite: a generous budget for one `<timestamp> <event>`.
 */
export const HISTORY_LINE_BYTES = 200;
/** How long an append waits for the history lock before writing without it. */
export const LOCK_WAIT_MS = 2000;
/** A history lock this old is from a run that was killed holding it. */
export const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_RETRY_MS = 50;

/**
 * Take `lock`, waiting up to LOCK_WAIT_MS for whoever holds it, or null when
 * it is still held. A process killed while holding one leaves the file
 * behind, so a lock older than LOCK_STALE_MS is taken away from it.
 */
function takeLock(lock: string): number | null {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return openSync(lock, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = statSync(lock, { throwIfNoEntry: false });
    if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
      rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return null;
    // Nothing to await: the updater's callers are synchronous.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
  }
}

/**
 * Cut the history log back to its last HISTORY_LINES lines, reading and
 * rewriting it whole, so only a file that has grown a margin past them is
 * worth it. The caller holds the lock.
 */
function trimHistory(history: string) {
  // One descriptor throughout: a size read from the path and a read of the
  // path are two different files if the log is rotated between them.
  const fd = openSync(history, 'r');
  let text: string;
  try {
    if (fstatSync(fd).size <= HISTORY_LINES * HISTORY_LINE_BYTES) return;
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length <= HISTORY_LINES) return;
  const temporary = writeTemporary(dirname(history), '.history-', lines.slice(-HISTORY_LINES).join('\n') + '\n');
  try {
    renameSync(temporary, history);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Append `line` to the history log, keeping about its last HISTORY_LINES
 * lines. Both the append and the trim hold `<history>.trimming`, so a trim's
 * read-rewrite can never drop a line another run appended meanwhile. An
 * append that waits the lock out writes anyway, rather than lose the event,
 * and leaves the trimming to the next run.
 */
export function appendHistory(history: string, line: string) {
  const lock = history + '.trimming';
  const held = takeLock(lock);
  try {
    appendFileSync(history, line);
    if (held !== null) trimHistory(history);
  } finally {
    if (held !== null) {
      closeSync(held);
      rmSync(lock, { force: true });
    }
  }
}
