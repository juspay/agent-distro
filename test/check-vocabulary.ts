/**
 * The vocabulary `src/package.json` exports for other programs, without a VM:
 * every export resolves through the package's own `exports` map, the history
 * line round-trips through its writer and reader, a malformed line or versions
 * row is refused, `changes` words what moved between two packages, and the
 * scheduled-run numbers and stamp reader are the ones `--scheduled` uses, the
 * state directory's files are where the updater keeps them, a profile
 * reference classifies and prefetches as a launch reads it, and the history
 * log's writer keeps it trimmed (test/check-would-compile.ts checks its lock).
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
const state = modules['./update/state'] as typeof import('../src/update/state.ts');
const reference = modules['./profile/reference'] as typeof import('../src/profile/reference.ts');
const historyLog = modules['./update/history-log'] as typeof import('../src/update/history-log.ts');
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
// A line written before #115 named its profile; it still reads, and says so.
assert.deepEqual(history.parseHistoryLine(`${history.timestamp(at)} vanilla updated: Pi 0.3 → 0.4`), {
  at: history.timestamp(at), kind: 'updated', words: 'Pi 0.3 → 0.4', profile: 'vanilla',
});
assert.equal(history.parseHistoryLine(line.slice(0, -1)).profile, undefined);
for (const bad of ['', 'updated: x', `${history.timestamp(at)} a b updated: x`, 'yesterday updated: x', `${history.timestamp(at)} done: x`]) {
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

// The state directory's files.
assert.equal(state.currentLink('/s/agent-distro/abc'), '/s/agent-distro/abc/current');
assert.equal(state.lastSuccessFile('/s/agent-distro/abc'), '/s/agent-distro/abc/last-success');

// A profile reference: a path (absolute, `~/`, or relative to a cwd), a flake
// reference (anything holding `/` or `:`), or nothing.
const where = { home: '/home/u', cwd: '/work/repo' };
assert.deepEqual(reference.classifyReference('/abs/p', where), { path: '/abs/p' });
assert.deepEqual(reference.classifyReference('~/p', where), { path: '/home/u/p' });
assert.deepEqual(reference.classifyReference('./p', where), { path: '/work/repo/./p' });
assert.deepEqual(reference.classifyReference('..', where), { path: '/work/repo/..' });
assert.deepEqual(reference.classifyReference('github:juspay/skills?dir=x', where), { flake: 'github:juspay/skills?dir=x' });
assert.deepEqual(reference.classifyReference('nixpkgs/nixos-unstable', where), { flake: 'nixpkgs/nixos-unstable' });
assert.equal(reference.classifyReference('juspay', where), null);
assert.equal(reference.classifyReference('~/p', { cwd: '/w' }), null);
assert.equal(reference.classifyReference('./p', { home: '/h' }), null);
// Only an indirect reference consults the global registry.
assert.deepEqual(reference.prefetchArgs('github:o/r'), ['flake', 'prefetch', '--option', 'flake-registry', '', '--json', 'github:o/r']);
assert.deepEqual(reference.prefetchArgs('nixpkgs/x'), ['flake', 'prefetch', '--json', 'nixpkgs/x']);
assert.deepEqual(reference.prefetchedTree({ storePath: '/nix/store/a-src', locked: { rev: 'r1', dir: 'sub' } }),
  { path: '/nix/store/a-src/sub', dir: 'sub', rev: 'r1' });
assert.deepEqual(reference.prefetchedTree({ storePath: '/nix/store/a-src', original: { dir: 'o' } }),
  { path: '/nix/store/a-src/o', dir: 'o' });
assert.equal(reference.prefetchedTree({ locked: {} }), null);
assert.equal(reference.prefetchedTree(null), null);

// The history log's writer: appends, and keeps the newest HISTORY_LINES lines.
{
  const { mkdtempSync, readFileSync: read, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const log = join(mkdtempSync(join(tmpdir(), 'vocab-')), 'history.log');
  historyLog.appendHistory(log, history.historyLine('updated: a', at));
  assert.equal(history.parseHistory(read(log, 'utf8')).length, 1);
  const pad = 'x'.repeat(historyLog.HISTORY_LINE_BYTES);
  writeFileSync(log, Array.from({ length: historyLog.HISTORY_LINES }, (_, i) => history.historyLine(`skipped: ${i} ${pad}`, at)).join(''));
  historyLog.appendHistory(log, history.historyLine('updated: last', at));
  const events = history.parseHistory(read(log, 'utf8'));
  assert.equal(events.length, historyLog.HISTORY_LINES);
  assert.equal(events.at(-1)?.words, 'last');
}
