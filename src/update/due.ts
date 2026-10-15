/** Keep the UTC boundary calculation independent of launchd, the clock, and file I/O. */

/**
 * Whether an update is due at `now`: no successful update (`stamp`, epoch
 * seconds) since the latest instant of the form offset + k*period not after
 * now.
 */
export function updateDue(now: number, stamp: number | null, period: number, offset: number): boolean {
  const boundary = Math.floor((now - offset) / period) * period + offset;
  return stamp === null || stamp < boundary;
}

/**
 * A scheduled run (`--scheduled`) makes up to this many attempts when due, and
 * waits this long after a failed one before the next: launchd has no restart
 * limit of its own. A skip is not a failure, so it is not retried.
 */
export const SCHEDULED_ATTEMPTS = 3;
export const SCHEDULED_RETRY_SECONDS = 300;

/**
 * A `last-success` stamp as written (epoch seconds and a newline). An
 * unreadable stamp counts as no successful update, so it is replaced.
 */
export function parseStamp(text: string): number | null {
  const trimmed = text.trim();
  return /^[0-9]+$/.test(trimmed) ? Number(trimmed) : null;
}
