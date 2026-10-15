/**
 * The history log's line: `<time> <event>`, newline-terminated, where `<time>`
 * is local time with its offset (as `date +%Y-%m-%dT%H:%M:%S%:z` writes it)
 * and `<event>` is `updated: <changes>`, `skipped: <reason>` or
 * `failed: <reason>`. A run that changes nothing writes no line; it only
 * refreshes `last-success`.
 *
 * A log kept across the one-package release (#115) still holds lines written
 * before it, which named the profile they were about: `<time> <profile>
 * <event>`. The reader reads both, and says which profile an older line named.
 *
 * Its writer and its reader, with no file I/O: the updater appends with
 * `historyLine` (src/update/update.ts), and a consumer that writes to the same
 * log — or reads it back — uses the same two functions, so a host keeps one
 * log in one format whoever wrote each line.
 */

/** What a line records. */
export const KINDS = ['updated', 'skipped', 'failed'] as const;
export type Kind = typeof KINDS[number];

/** One line, read back. */
export type HistoryEvent = {
  /** When, exactly as written (local time with its offset). */
  at: string;
  kind: Kind;
  /** The words after `<kind>: `: what changed, or why not. */
  words: string;
  /** The profile a line written before the one-package release was about. */
  profile?: string;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time as `date +%Y-%m-%dT%H:%M:%S%:z` writes it. */
export function timestamp(date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const zone = (offset < 0 ? '-' : '+') + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
}

/** One line, newline-terminated, for `event` (`<kind>: <words>`) at `date`. */
export function historyLine(event: string, date = new Date()): string {
  return `${timestamp(date)} ${event}\n`;
}

const LINE = /^(\S+) (?:(\S+) )?(updated|skipped|failed): (.*)$/;

/**
 * One line (without its newline), read back — this format, or the one before
 * #115 with its profile. Throws on any other line, naming it: a reader never
 * takes a line it does not understand for one it does.
 */
export function parseHistoryLine(line: string): HistoryEvent {
  const match = LINE.exec(line);
  if (match === null || Number.isNaN(Date.parse(match[1] ?? ''))) {
    throw new Error(`history line is not '<time> <kind>: <words>': ${JSON.stringify(line)}`);
  }
  const event: HistoryEvent = { at: match[1] ?? '', kind: match[3] as Kind, words: match[4] ?? '' };
  if (match[2] !== undefined) event.profile = match[2];
  return event;
}

/** Every line of a history log's text, oldest first. */
export function parseHistory(text: string): HistoryEvent[] {
  return text.split('\n').filter((line) => line !== '').map(parseHistoryLine);
}
