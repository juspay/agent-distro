/**
 * The bytes a `--progress` run reports, from the internal-json stderr of a real
 * `nix build`. The fixture was captured on kolu-ci-8, downloading hello 2.12.1
 * from cache.nixos.org: a 600-byte narinfo and a 49 KiB nar transferred, and
 * 221 KiB copied, each an activity of its own.
 *
 * Usage: node check-update-progress.ts SRC FIXTURE
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const { NixLog } = await import(join(process.argv[2], 'update/progress.ts'));
const fixture = readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean);

/** Every event the fixture yields, with the clock advancing `step` ms a line. */
function read(step: number) {
  let now = 0;
  const log = new NixLog(() => now);
  const progress: { done: number; total: number }[] = [];
  /** The fixture line each sample came from, so a test can see the 500 ms gap. */
  const at: number[] = [];
  const text: string[] = [];
  fixture.forEach((line, index) => {
    now += step;
    const event = log.line(line);
    if (event === null) return;
    if ('text' in event) text.push(event.text);
    else {
      progress.push(event.progress);
      at.push(index);
    }
  });
  const held = log.flush();
  if (held) {
    progress.push(held);
    at.push(fixture.length);
  }
  return { progress, at, text };
}

test('a real build sums every activity it fetches', () => {
  const { progress, text } = read(1000);
  // 600 + 50216 + 226560: the ids nix gives these activities are past 2^53, so
  // an id read as a JSON number would round two of them into one.
  assert.deepEqual(progress.at(-1), { done: 277376, total: 277376 });
  assert.ok(progress.every((sample, i) => i === 0 || sample.done >= progress[i - 1].done), JSON.stringify(progress));
  assert.ok(progress.every((sample) => sample.done <= sample.total), JSON.stringify(progress));
  // Nix's own messages are re-emitted, and nothing else of its stderr is lost.
  assert.equal(text.length, 3);
  assert.match(text[0], /creating lock file/);
  assert.match(text[1], /this path will be fetched/);
});

test('samples keep to one per 500 ms', () => {
  // 100 ms a line: consecutive samples must be at least five lines apart.
  const { progress, at } = read(100);
  assert.ok(progress.length > 1 && progress.length < 40, `${progress.length}`);
  assert.ok(at.every((index, i) => i === 0 || index - at[i - 1] >= 5), JSON.stringify(at));
});

test('the last sample waits for the flush, not the clock', () => {
  // A clock that never moves: only the first sample fits, and the flush ends it.
  const { progress } = read(0);
  assert.deepEqual(progress, [{ done: 600, total: 600 }, { done: 277376, total: 277376 }]);
});

test('bookkeeping is consumed, and anything else reaches stderr', () => {
  const log = new NixLog();
  assert.equal(log.line('@nix {"action":"start","id":1,"type":102}'), null);
  assert.equal(log.line('@nix {"action":"stop","id":1}'), null);
  assert.deepEqual(log.line('error: cannot build'), { text: 'error: cannot build\n' });
  assert.deepEqual(log.line('@nix not json'), { text: '@nix not json\n' });
});
