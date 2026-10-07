/**
 * The picker's text and layout without a VM or a terminal: cell widths,
 * wrapping, and the master–detail frame that never cuts a line, at the sizes
 * users have.
 *
 * Usage: node check-picker-layout.ts SRC
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
// Erased at run time; the modules themselves come from SRC.
import type { Layout } from '../src/picker/choose.ts';
import type { Listing } from '../src/listing.ts';

const src = process.argv[2];
// The module's path is the SRC argument, so it cannot be a static import.
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

type Auth = { text: string; items: string[] };
const harness = (name: string, title: string, tagline: string, version: string, auth?: Auth) => ({ name, title, tagline, version, auth });
const AUTH: Record<string, Auth> = {
  omp: { text: 'LITELLM_API_KEY, anthropic, openai', items: ['LITELLM_API_KEY', 'anthropic', 'openai'] },
  codex: { text: 'ChatGPT', items: ['ChatGPT'] },
  claude: { text: 'me@example.com', items: ['me@example.com'] },
  opencode: { text: 'not signed in', items: [] },
  pi: { text: 'LITELLM_API_KEY', items: ['LITELLM_API_KEY'] },
};
const HARNESSES = [
  harness('omp', 'Oh My Pi', 'gateway or own provider · extensions', '18.7.0', AUTH.omp),
  harness('codex', 'Codex', 'OpenAI login · plugins via marketplace', '0.160.1', AUTH.codex),
  harness('claude', 'Claude Code', 'Anthropic login · plugin dirs per session', '2.1.292', AUTH.claude),
  harness('opencode', 'OpenCode', 'v1 · gateway or own provider', '1.18.35', AUTH.opencode),
  harness('opencode2', 'OpenCode v2', 'v2 preview · private server per launch', '2.0.24'),
  harness('pi', 'Pi', "OMP's upstream · gateway via models.json", '1.0.4', AUTH.pi),
];
const OTHER = [HARNESSES[1], HARNESSES[5]];
const SHORT = ['Juspay skills + Kolu, via Juspay\'s LiteLLM gateway', 'Upstream harnesses with your own provider', 'A third profile'];
const listing = (descriptions: string[], harnesses = HARNESSES): Listing => ({
  profiles: descriptions.map((description, i) => ({ name: ['juspay', 'vanilla', 'third'][i], description, harnesses })),
});
const TWO: Listing = {
  profiles: [
    { name: 'juspay', description: SHORT[0], harnesses: HARNESSES },
    { name: 'vanilla', description: SHORT[1], harnesses: OTHER },
  ],
};

/** The cells a frame draws, one string per row, exactly as written. */
function cells(frame: string, columns: number, rows: number): string[] {
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
  return grid.map((row) => row.join(''));
}
const screen = (frame: string, columns: number, rows: number) => cells(frame, columns, rows).map((line) => line.trimEnd());

const colors = palette({ NO_COLOR: '1' });
/** A frame as the terminal gets it: layout for the size, then render. */
function frame(menu: InstanceType<typeof Menu>, rows: number, columns: number): string {
  const l = layout(menu, columns, rows);
  assert.ok(l, `no layout fits ${columns}×${rows}`);
  return render(menu, l, colors);
}
/** The frame's lines as rendered, escapes and all. */
const rendered = (menu: InstanceType<typeof Menu>, columns: number, rows: number) =>
  frame(menu, rows, columns).split(/(?=\x1b\[\d+;\d+H\x1b\[K)/).filter((line) => line.includes('\x1b[K'));

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

/** The box's body, cut to the list and panel columns, so a cell can be read. */
function body(menu: InstanceType<typeof Menu>, columns: number, rows: number): string[] {
  const l = layout(menu, columns, rows)!;
  const left = l.x - 1;
  return cells(frame(menu, rows, columns), columns, rows)
    .slice(l.y + l.profile + 1, l.y + l.profile + 1 + l.body)
    .map((line) => line.slice(left, left + l.inner + 4));
}
/** The profile row's text, cut to the box's inner width so a wrap reads whole. */
function profileRow(menu: InstanceType<typeof Menu>, columns: number, rows: number): string {
  const l = layout(menu, columns, rows)!;
  const left = l.x - 1;
  return cells(frame(menu, rows, columns), columns, rows)
    .slice(l.y, l.y + l.profile)
    .map((line) => line.slice(left + 2, left + 2 + l.inner))
    .join('\n')
    .replace(/\s+/g, ' ');
}
const listCell = (line: string, l: Layout) => line.slice(2, 2 + l.list);
const panelCell = (line: string, l: Layout) => line.slice(2 + l.list + 3, 2 + l.list + 3 + l.panel);
/** The title a list cell shows, so a row can be found by its title alone. */
const titleCell = (line: string, l: Layout) => listCell(line, l).slice(6, 6 + l.title).trimEnd();
/** Panel text with its wraps undone, so a wrapped line can be looked for. */
const panelText = (menu: InstanceType<typeof Menu>, columns: number, rows: number) => {
  const l = layout(menu, columns, rows)!;
  return body(menu, columns, rows).map((line) => panelCell(line, l)).join('\n').replace(/\s+/g, ' ');
};

// The box is straight at the sizes users have, with one, two and three
// profiles; every row keeps its version on the list's right edge; nothing in
// the body is cut; and the highlighted harness's tagline, status items and the
// profile line are all there.
for (const count of [1, 2, 3]) {
  for (const [columns, rows] of [[80, 24], [60, 24], [120, 30]] as const) {
    const menu = new Menu(listing(SHORT.slice(0, count)), 'juspay/claude');
    const l = layout(menu, columns, rows)!;
    const lines = boxed(menu, columns, rows);
    const cellsOfBody = body(menu, columns, rows);
    for (const h of HARNESSES) {
      const line = cellsOfBody.find((b) => titleCell(b, l) === h.title);
      assert.ok(line, `no row for ${h.title} at ${columns}×${rows}:\n${lines.join('\n')}`);
      assert.ok(listCell(line, l).trimEnd().endsWith(h.version), listCell(line, l));
      // The status mark: ✓ where signed in, blank otherwise.
      assert.equal(listCell(line, l).slice(4, 6).trim(), h.auth?.items.length ? '✓' : '', listCell(line, l));
    }
    assert.ok(!cellsOfBody.join('').includes('…'), `cut in the body at ${columns}×${rows}:\n${cellsOfBody.join('\n')}`);
    const shown = menu.current()!;
    const panel = panelText(menu, columns, rows);
    assert.ok(panel.includes(shown.tagline), panel);
    for (const item of shown.auth?.items ?? []) assert.ok(panel.includes(item), panel);
    // The profile row, under the header, names the profile and describes it.
    const row = profileRow(menu, columns, rows);
    assert.ok(row.includes(`${menu.active.name} · ${menu.active.description}`), row);
  }
}

// Too small is no layout at all, the one meaning of "does not fit".
assert.equal(layout(new Menu(listing(SHORT.slice(0, 2)), ''), 30, 8), undefined);
assert.equal(layout(new Menu(listing(SHORT.slice(0, 2)), ''), 50, 24), undefined);
// Colour follows NO_COLOR and the terminal: ANSI has eight colours, a VT100 none.
assert.match(palette({ TERM: 'ansi' }).accent, /36/);
assert.doesNotMatch(palette({ TERM: 'vt100' }).accent, /36/);
assert.doesNotMatch(palette({ TERM: 'xterm-256color', NO_COLOR: '1' }).accent, /36/);

// Switching profile — →, Tab and l forward, ←, Shift-Tab and h back — changes
// the header's accent and the list.
for (const key of ['right', 'tab', 'l']) {
  const menu = new Menu(TWO, '');
  assert.equal(menu.active.name, 'juspay');
  menu.press(key);
  assert.equal(menu.active.name, 'vanilla');
  assert.equal(menu.index, 0);
  const header = rendered(menu, 80, 24)[0];
  assert.ok(header.includes('\x1b[1mvanilla'), header);
  assert.ok(header.includes('\x1b[2mjuspay'), header);
  assert.ok(header.includes(' · '), header);
  const drawn = boxed(menu, 80, 24).join('\n');
  assert.ok(drawn.includes('Codex'), drawn);
  assert.ok(!drawn.includes('Oh My Pi'), drawn);
}
for (const key of ['left', 'backtab', 'h']) {
  const menu = new Menu(TWO, '');
  menu.press('right');
  menu.press(key);
  assert.equal(menu.active.name, 'juspay');
}
// The remembered harness is where the cursor lands when its profile opens, and
// it keeps its dot; the other rows have none.
const toVanilla = new Menu(TWO, 'vanilla/pi');
assert.equal(toVanilla.active.name, 'vanilla');
assert.equal(toVanilla.index, 1);
const markedL = layout(toVanilla, 80, 24)!;
const markedBody = body(toVanilla, 80, 24);
const dot = (title: string) => listCell(markedBody.find((b) => titleCell(b, markedL) === title)!, markedL).slice(2, 4);
assert.equal(dot('Pi'), '• ', 'the remembered harness keeps its dot');
assert.equal(dot('Codex'), '  ');
// A single-profile distribution shows its one name, not as a tab.
const one = boxed(new Menu(listing(SHORT.slice(0, 1)), ''), 80, 24).join('\n');
assert.ok(one.includes('agent-distro · juspay'), one);
assert.ok(!one.includes(' · vanilla'), one);

// Wide and joined characters in the data keep the border straight.
const emoji = listing(SHORT.slice(0, 2), [
  harness('fam', '👨\u200d👩\u200d👧 Fam', '🇯🇵 flag · ❤\ufe0f heart', '1.0', AUTH.claude),
  harness('cjk', '日本語', '中文说明 · 한국어 \u{2000B}', '2.0', AUTH.omp),
  ...HARNESSES,
]);
boxed(new Menu(emoji, ''), 80, 24);
boxed(new Menu(emoji, ''), 120, 30);

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
// The filter matches a tagline the row no longer shows.
const byTagline = new Menu(listing(SHORT.slice(0, 1)), '');
byTagline.press('/');
for (const character of 'gateway') byTagline.press(character);
assert.deepEqual(byTagline.rows().map((r) => r.name), ['omp', 'opencode', 'pi']);
// No matches blanks the panel, and the list says so.
const none = new Menu(listing(SHORT.slice(0, 1)), '');
none.press('/');
for (const character of 'nonesuch') none.press(character);
assert.ok(boxed(none, 80, 24).join('\n').includes('No matches'));
assert.ok(!panelText(none, 80, 24).trim(), 'the panel is blank when nothing matches');

// The remembered choice starts the cursor; the first profile is the default.
const remembered = new Menu(listing(SHORT.slice(0, 2)), 'vanilla/claude');
assert.equal(remembered.active.name, 'vanilla');
assert.equal(remembered.index, HARNESSES.findIndex((h) => h.name === 'claude'));
assert.equal(new Menu(listing(SHORT.slice(0, 2)), '').active.name, 'juspay');

// A menu that is not a Listing is an argument error, exit 2.
const node = process.execPath;
const bad = spawnSync(node, [join(src, 'picker/choose.ts'), JSON.stringify({ profiles: [{ name: 'a', description: '', harnesses: [{ name: 'x', title: 'X', tagline: null, version: '1' }] }] })], { encoding: 'utf8' });
assert.equal(bad.status, 2, bad.stderr);
assert.match(bad.stderr, /tagline is not a string/);
console.log('picker layout: all checks passed');
