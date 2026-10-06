// Synthetic epoch seconds keep boundary tests independent of the host clock and zone.
// Usage: node check-update-due.ts SRC
import assert from 'node:assert/strict';
import { join } from 'node:path';

const { updateDue } = await import(join(process.argv[2], 'update/due.ts'));
const base = 20000 * 86400;
const b1 = base + 7200; // 02:00 UTC
const b2 = base + 28800; // 08:00 UTC
const b3 = base + 50400; // 14:00 UTC

function check(label: string, now: number, stamp: number | null, expected: 'due' | 'wait') {
  assert.equal(updateDue(now, stamp, 21600, 7200) ? 'due' : 'wait', expected, label);
}

check('no stamp', b3 + 3600, null, 'due');
check('stamp before latest boundary', b3 + 3600, b3 - 1, 'due');
check('stamp in the current cycle', b3 + 3600, b3 + 1, 'wait');
check('before first boundary, updated at the previous last boundary', b1 - 3600, b1 - 21600, 'wait');
check('exactly at a boundary, previous cycle stamp', b2, b2 - 1, 'due');
check('exactly at a boundary, current cycle stamp', b2, b2, 'wait');
check('slept across several periods', b3 + 3600, b3 - 3 * 21600, 'due');
