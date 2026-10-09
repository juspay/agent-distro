/**
 * The bytes nix fetches, read from the stderr of `nix build --log-format
 * internal-json`. Nix announces every activity with a `start` line, and reports
 * it with a `result` of type 105 (progress: done, expected, running, failed) or
 * type 106 (set expected, the batch total of one activity type). Only the
 * copy-path and file-transfer activities count bytes; the copy-paths, builds
 * and realise activities report items, or nothing at all.
 *
 * A parse carries the two things a run needs: the samples a consumer draws a
 * progress bar from, and every line that is not bookkeeping, so nix's own
 * output still reaches the user.
 */

import { printable } from '../util.ts';

/** Activity types whose progress counts bytes rather than items. */
const BYTES = new Set([100 /* copy path */, 101 /* file transfer */]);
/** Result types carrying the numbers: an activity's progress, and a batch's expected total. */
const PROGRESS = 105;
const SET_EXPECTED = 106;
/** At most one sample per this many milliseconds, however fast nix reports. */
const INTERVAL = 500;

/** What one stderr line asks of the updater. */
export type Event =
  /** A sample to emit: bytes done out of the bytes expected so far. */
  | { progress: { done: number; total: number } }
  /** A line for the user's stderr: nix's own message, or anything not internal-json. */
  | { text: string };

/**
 * The cause nix names in one of its `error:` lines: the innermost one wins,
 * because nix prints `… while fetching …` context and then `error: <cause>`.
 * The prefix is removed, control characters escaped, and the rest cut to
 * 300 characters. Null when nix printed no such line.
 */
export function nixErrorDetail(text: string): string | null {
  let detail: string | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('error:')) continue;
    const cause = printable(trimmed.slice('error:'.length).trim()).slice(0, 300);
    if (cause !== '') detail = cause;
  }
  return detail;
}

type Activity = { type: number; done: number; expected: number };

const integer = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export class NixLog {
  /** Nix's activity ids are strings: they exceed 2^53, so JSON numbers round together. */
  private readonly activities = new Map<string, Activity>();
  /** Expected bytes per activity type, as `result` 106 sets them for a batch. */
  private readonly expected = new Map<number, number>();
  /** The last sample emitted, so only a change is reported. */
  private done = -1;
  private total = -1;
  private at = -Infinity;
  /** The failed result's `detail`: nix's last `error:` line, scrubbed; null when none. */
  errorDetail: string | null = null;
  /** Node's type stripping has no parameter properties, so the clock is a field. */
  private readonly now: () => number;

  /** `now` is injectable so a test can pin the 500 ms gap. */
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Consume one line of nix's stderr: the event it yields, or null for bookkeeping. */
  line(line: string): Event | null {
    if (!line.startsWith('@nix ')) return this.text(`${line}\n`);
    let record: Record<string, unknown>;
    try {
      // Quoting the id keeps it exact: nix's ids are past 2^53, and as JSON
      // numbers two activities would round to the same one.
      record = JSON.parse(line.slice('@nix '.length).replace(/"id":(\d+)/, '"id":"$1"'));
    } catch {
      return this.text(`${line}\n`);
    }
    if (record?.action === 'msg' && typeof record.msg === 'string') {
      return this.text(record.msg.endsWith('\n') ? record.msg : `${record.msg}\n`);
    }
    const id = String(record?.id);
    if (record?.action === 'start') {
      this.activities.set(id, { type: integer(record.type), done: 0, expected: 0 });
      return null;
    }
    if (record?.action !== 'result' || !Array.isArray(record.fields)) return null;
    const fields = record.fields as unknown[];
    if (record.type === PROGRESS) {
      const activity = this.activities.get(id);
      if (activity === undefined || !BYTES.has(activity.type)) return null;
      activity.done = integer(fields[0]);
      activity.expected = integer(fields[1]);
    } else if (record.type === SET_EXPECTED) {
      if (!BYTES.has(integer(fields[0]))) return null;
      this.expected.set(integer(fields[0]), integer(fields[1]));
    } else {
      return null;
    }
    const sample = this.sample();
    return sample === null ? null : { progress: sample };
  }

  /** A text event, remembering nix's last `error:` line for the failed result. */
  private text(text: string): Event {
    const detail = nixErrorDetail(text);
    if (detail !== null) this.errorDetail = detail;
    return { text };
  }

  /** The sample the 500 ms gap is still holding back, for the end of the build. */
  flush(): { done: number; total: number } | null {
    this.at = -Infinity;
    return this.sample();
  }

  /**
   * What the copy and transfer activities have done so far, out of what they
   * expect: the activities are summed, and a batch's own expected total (106)
   * stands in where one activity has not reported its own yet. Reported on
   * change, at most every 500 ms.
   */
  private sample(): { done: number; total: number } | null {
    let done = 0;
    const per = new Map<number, number>();
    for (const activity of this.activities.values()) {
      if (!BYTES.has(activity.type)) continue;
      done += activity.done;
      per.set(activity.type, (per.get(activity.type) ?? 0) + activity.expected);
    }
    let total = 0;
    for (const type of BYTES) total += Math.max(per.get(type) ?? 0, this.expected.get(type) ?? 0);
    if (total === 0 || (done === this.done && total === this.total)) return null;
    const at = this.now();
    if (at - this.at < INTERVAL) return null;
    this.done = done;
    this.total = total;
    this.at = at;
    return { done, total };
  }
}
