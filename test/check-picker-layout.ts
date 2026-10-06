/**
 * The picker's text and layout without a VM or a terminal: cell widths,
 * truncation, wrapping, and frames that stay inside their box and the
 * terminal at the sizes users have.
 *
 * Usage: node check-picker-layout.ts SRC
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
// Erased at run time; the modules themselves come from SRC.
import type { Listing } from '../src/listing.ts';

const src = process.argv[2];
const { Menu, layout, render, palette, width, fit, tail, wrap } = await import(join(src, 'picker/choose.ts'));

// Cells as a terminal draws them, one grapheme at a time.
for (const [text, cells] of [
  ['abc', 3], ['é', 1], ['e\u0301', 1], ['😀', 2], ['👨\u200d👩\u200d👧', 2], ['🇯🇵', 2],
  ['❤\ufe0f', 2], ['❤', 1], ['日本', 4], ['\u{2000B}', 2], ['한', 2], ['한', 2],
  ['👨\u200d👩\u200d👧 Fam', 6],
  // Plain Latin and punctuation take the fast path, with the same answer.
  ['gateway · extensions…', 21], ['a\u0301 · b', 5],
] as const) {
  assert.equal(width(text), cells, JSON.stringify(text));
}

// Cuts keep what fits, end in an ellipsis, and prefer a word boundary.
assert.equal(fit('aaaa bbbb cccc dddd', 15), 'aaaa bbbb cccc…');
assert.equal(fit('Anthropic login · plugin dirs per session', 26), 'Anthropic login · plugin…');
assert.equal(fit('abcdefghij', 5), 'abcd…');
assert.equal(fit('日本語テキスト', 7), '日本語…');
assert.equal(fit('anything', 0), '');
assert.equal(tail('日本語のクエリ', 6), '…エリ');
assert.equal(tail('abc', 1), '…');
assert.equal(tail('abc', 0), '');
// A word longer than a line is broken, not cut; overflow ends in an ellipsis.
assert.deepEqual(wrap('see https://example.com/a/b here', 12, 9), ['see', 'https://exam', 'ple.com/a/b', 'here']);
assert.deepEqual(wrap('one two three four', 9, 1), ['one two…']);

const harness = (name: string, title: string, tagline: string, version: string) => ({ name, title, tagline, version });
const HARNESSES = [
  harness('omp', 'Oh My Pi', 'gateway or own provider · extensions', '18.6.3'),
  harness('codex', 'Codex', 'OpenAI login · plugins via marketplace', '0.160.1'),
  harness('claude', 'Claude Code', 'Anthropic login · plugin dirs per session', '2.1.291'),
  harness('opencode', 'OpenCode', 'v1 · gateway or own provider', '1.18.34'),
  harness('opencode2', 'OpenCode v2', 'v2 preview · private server per launch', '2.0.24'),
  harness('pi', 'Pi', "OMP's upstream · gateway via models.json", '1.0.4'),
];
const listing = (descriptions: string[], harnesses = HARNESSES): Listing => ({
  profiles: descriptions.map((description, i) => ({ name: ['juspay', 'vanilla', 'third'][i], description, harnesses })),
});
const SHORT = ['Juspay skills + Kolu, via Juspay\'s LiteLLM gateway', 'Upstream harnesses with your own provider', 'A third profile'];

/** The screen a frame draws: rows of cells, written grapheme by grapheme. */
function screen(frame: string, columns: number, rows: number): string[] {
  const grid = Array.from({ length: rows }, () => Array<string>(columns).fill(' '));
  let y = 0;
  let x = 0;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const part of frame.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    const move = part.match(/^\x1b\[(\d+);(\d+)H$/);
    if (move) [y, x] = [Number(move[1]) - 1, Number(move[2]) - 1];
    else if (part === '\x1b[K') grid[y]?.fill(' ', x);
    else if (!part.startsWith('\x1b')) {
      for (const { segment } of graphemes.segment(part)) {
        assert.ok(y < rows && x + width(segment) <= columns, `drawn outside the terminal at ${y},${x}: ${JSON.stringify(segment)}`);
        grid[y][x] = segment;
        for (let i = 1; i < width(segment); i++) grid[y][x + i] = '';
        x += width(segment);
      }
    }
  }
  return grid.map((row) => row.join('').trimEnd());
}

/** Draw, and check the box: every line the same width, its right edge intact. */
function boxed(menu: InstanceType<typeof Menu>, columns: number, rows: number): string[] {
  const lines = screen(frame(menu, rows, columns), columns, rows);
  const box = lines.filter((line) => /^\s*[╭│├╰]/.test(line));
  const widths = new Set(box.map((line) => width(line)));
  assert.equal(widths.size, 1, `box lines differ in width:\n${box.join('\n')}`);
  for (const line of box) assert.match(line, /[╮│┤╯]$/, `right edge missing:\n${line}`);
  assert.ok(width(box[0]) <= columns);
  return lines;
}

const colors = palette({ NO_COLOR: '1' });
/** A frame as the terminal gets it: layout for the size, then render. */
function frame(menu: InstanceType<typeof Menu>, rows: number, columns: number): string {
  const l = layout(menu, columns, rows);
  assert.ok(l, `no layout fits ${columns}×${rows}`);
  return render(menu, l, colors);
}
// 80×24 fits one to three profiles with twelve harnesses; so do wide
// terminals, and the box fills the terminal exactly when it must.
const twelve = [...HARNESSES, ...HARNESSES.map((h) => ({ ...h, name: h.name + '-2' }))];
for (const count of [1, 2, 3]) {
  for (const [columns, rows] of [[80, 24], [120, 30], [60, 24], [72, 24]]) {
    boxed(new Menu(listing(SHORT.slice(0, count), twelve), ''), columns, rows);
  }
}
// Too small is no layout at all, the one meaning of "does not fit".
assert.equal(layout(new Menu(listing(SHORT.slice(0, 2)), ''), 30, 8), undefined);
// Colour follows NO_COLOR and the terminal: ANSI has eight colours, a VT100 none.
assert.match(palette({ TERM: 'ansi' }).accent, /36/);
assert.doesNotMatch(palette({ TERM: 'vt100' }).accent, /36/);
assert.doesNotMatch(palette({ TERM: 'xterm-256color', NO_COLOR: '1' }).accent, /36/);

// Two panes keep the divider in the header even at 60 columns, and versions
// keep to the right edge when taglines have no room.
const narrow = boxed(new Menu(listing(SHORT.slice(0, 2)), ''), 60, 24);
assert.match(narrow.join('\n'), /┬/);
for (const h of HARNESSES) {
  const line = narrow.find((l) => l.includes('   ' + h.title + ' '))!;
  assert.ok(line.endsWith(h.version + '  │'), line);
}

// One long description wraps in its pane rather than taking the taglines' room.
const taglines = (descriptions: string[]) =>
  boxed(new Menu(listing(descriptions), ''), 80, 24).find((line) => line.includes('Codex'))!;
assert.equal(
  taglines([SHORT[0], 'A much longer description of the second profile that would like a wide pane to itself', SHORT[2]]),
  taglines(SHORT),
);

// Wide and joined characters in the data keep the border straight.
const emoji = listing(SHORT.slice(0, 2), [
  harness('fam', '👨\u200d👩\u200d👧 Fam', '🇯🇵 flag · ❤\ufe0f heart', '1.0'),
  harness('cjk', '日本語', '中文说明 · 한국어 \u{2000B}', '2.0'),
  ...HARNESSES,
]);
boxed(new Menu(emoji, ''), 80, 24);

// A long CJK query stays inside the filter line, the cursor with it.
const query = new Menu(emoji, '');
query.press('/');
for (const character of '日本語のとても長い検索クエリをここに入力します') query.press(character);
const filterLine = boxed(query, 60, 24).find((line) => line.includes('no matches'))!;
assert.ok(filterLine.includes('…'), filterLine);
const cursor = frame(query, 24, 60).match(/\x1b\[(\d+);(\d+)H\x1b\[\?25h$/)!;
assert.ok(Number(cursor[2]) < 60, `cursor at column ${cursor[2]}`);

// Backspace removes a whole character: no lone surrogate, no half a family.
const typed = new Menu(emoji, '');
typed.press('/');
for (const key of ['a', '😀', '👨', '\u200d', '👩', '\u200d', '👧']) typed.press(key);
assert.equal(typed.query, 'a😀👨\u200d👩\u200d👧');
typed.press('backspace');
assert.equal(typed.query, 'a😀');
typed.press('backspace');
assert.equal(typed.query, 'a');

// A filtered cursor survives the filter being cleared (and so a fallback).
const filtered = new Menu(listing(SHORT.slice(0, 1)), '');
filtered.press('/');
for (const character of 'pi') filtered.press(character);
while (filtered.rows()[filtered.index].name !== 'pi') filtered.press('down');
assert.ok(filtered.index > 0);
filtered.clearFilter();
assert.equal(filtered.rows()[filtered.index].name, 'pi');

// The remembered choice starts the cursor; the first profile is the default.
const remembered = new Menu(listing(SHORT.slice(0, 2)), 'vanilla/claude');
assert.equal(remembered.index, 1);
remembered.press('enter');
assert.equal(remembered.rows()[remembered.index].name, 'claude');
assert.equal(new Menu(listing(SHORT.slice(0, 2)), '').index, 0);

// A menu that is not a Listing is an argument error, exit 2.
const node = process.execPath;
const bad = spawnSync(node, [join(src, 'picker/choose.ts'), JSON.stringify({ profiles: [{ name: 'a', description: '', harnesses: [{ name: 'x', title: 'X', tagline: null, version: '1' }] }] })], { encoding: 'utf8' });
assert.equal(bad.status, 2, bad.stderr);
assert.match(bad.stderr, /tagline is not a string/);
console.log('picker layout: all checks passed');
