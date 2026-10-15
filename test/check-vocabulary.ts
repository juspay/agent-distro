/**
 * The vocabulary `src/package.json` exports for other programs, without a VM:
 * every export resolves through the package's own `exports` map, the history
 * line round-trips through its writer and reader, a malformed line or versions
 * row is refused, `changes` words what moved between two packages, and the
 * scheduled-run numbers and stamp reader are the ones `--scheduled` uses.
 *
 * Usage: node check-vocabulary.ts SRC
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const src = process.argv[2]!;
const manifest = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@juspay/agent-distro');
const modules: Record<string, Record<string, unknown>> = {};
for (const [key, file] of Object.entries(manifest.exports as Record<string, string>)) {
  modules[key] = await import(pathToFileURL(join(src, file)).href);
}
const history = modules['./update/history'] as typeof import('../src/update/history.ts');
const versions = modules['./update/versions'] as typeof import('../src/update/versions.ts');
const due = modules['./update/due'] as typeof import('../src/update/due.ts');
assert.ok(modules['./listing']?.parseListing, './listing exports parseListing');

// The writer's line is what the reader reads back, newline and all.
const at = new Date(2026, 9, 15, 2, 0, 7);
const line = history.historyLine('updated: Claude Code 2.0.1 → 2.0.3', at);
assert.ok(line.endsWith('\n'));
assert.match(line, /^2026-10-15T02:00:07[+-]\d\d:\d\d updated: /);
assert.deepEqual(history.parseHistoryLine(line.slice(0, -1)), {
  at: history.timestamp(at), kind: 'updated', words: 'Claude Code 2.0.1 → 2.0.3',
});
assert.deepEqual(history.parseHistory(`${history.historyLine('skipped: offline', at)}${history.historyLine('failed: nix build exit 1', at)}`)
  .map((e) => e.kind), ['skipped', 'failed']);
// Words may be empty, and may hold colons.
assert.equal(history.parseHistoryLine(`${history.timestamp(at)} failed: a: b`).words, 'a: b');
// A line written before #115, with its profile, is not this format.
for (const bad of ['', 'updated: x', `${history.timestamp(at)} default updated: x`, 'yesterday updated: x', `${history.timestamp(at)} done: x`]) {
  assert.throws(() => history.parseHistoryLine(bad), /history line is not/, JSON.stringify(bad));
}

// Versions: a version may hold tabs; a short row is refused.
const v1 = versions.parseVersions('claude\tClaude Code\t2.0.1\npi\tPi\t0.3\tbeta\n');
assert.deepEqual(v1, [
  { name: 'claude', title: 'Claude Code', version: '2.0.1' },
  { name: 'pi', title: 'Pi', version: '0.3\tbeta' },
]);
assert.throws(() => versions.parseVersions('claude\tClaude Code\n'), /versions line is not/);
assert.equal(versions.VERSIONS_FILE, 'share/agent-distro/versions');
const v2 = versions.parseVersions('claude\tClaude Code\t2.0.3\nomp\tOh My Pi\t18.11.1\n');
assert.equal(versions.changes(v1, v2), 'Claude Code 2.0.1 → 2.0.3, Oh My Pi added 18.11.1, Pi removed');
assert.equal(versions.changes(null, v2), 'Claude Code 2.0.3, Oh My Pi 18.11.1');
assert.equal(versions.changes(v2, v2), 'no harness version changed');
assert.equal(versions.changes(v2, null), 'versions not recorded by this package');

// The scheduled run's numbers, and its stamp reader.
assert.equal(due.SCHEDULED_ATTEMPTS, 3);
assert.equal(due.SCHEDULED_RETRY_SECONDS, 300);
assert.equal(due.parseStamp('1760000000\n'), 1760000000);
assert.equal(due.parseStamp('soon'), null);
assert.equal(due.parseStamp(''), null);
