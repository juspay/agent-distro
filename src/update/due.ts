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
