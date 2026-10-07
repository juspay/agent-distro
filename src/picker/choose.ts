/**
 * Draw a menu and return a choice; launching and persistence belong to agent-distro.
 *
 * Usage: node choose.ts MENU_JSON [--auth AUTH_JSON] [--profile NAME] [--remembered PROFILE/HARNESS]
 *
 * MENU_JSON is the `--list --json` value (src/listing.ts). AUTH_JSON maps
 * `profile/harness` to the probe spec (src/picker/auth.ts) whose status is
 * drawn on that row; it is a launch-time fact, so `--list` never carries it.
 * Prints `profile/harness` on stdout and exits 0, or prints nothing and exits
 * 0 when the user quits; argument errors exit 2. The menu is drawn on /dev/tty,
 * since the shell captures stdout; a terminal too small or unsupported for
 * the boxed view at start gets a numbered list on stderr.
 *
 * Three parts with their own reasons to change: Menu (what is chosen, per
 * key), layout (where things go, per terminal size) and render (one frame),
 * and the I/O around them, draw and plain.
 */
import { existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { emitKeypressEvents, createInterface, type Key } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { WriteStream } from 'node:tty';
import { parseArgs } from 'node:util';
import { parseListing, type Listing, type Profile } from '../listing.ts';
import { probe, type Io, type Spec, type Status } from './auth.ts';

type Row = { name: string; title: string; tagline: string; version?: string; auth?: Status };

// Terminal cells per user-perceived character (grapheme): none for a lone
// combining or format mark, two for East Asian wide characters, emoji
// (presentation by default, or forced by U+FE0F) and flags, else one.
// Text of only narrow, standalone characters (Latin, general punctuation,
// arrows, box drawing) is one cell per code point; only other text pays for
// ICU's segmenter, created on first use.
const SIMPLE = /^[\x20-\x7e\u00a0-\u02ff\u2010-\u2027\u2030-\u205e\u2190-\u21ff\u2500-\u257f]*$/;
let graphemes: Intl.Segmenter | undefined;
const split = (text: string) =>
  SIMPLE.test(text)
    ? [...text]
    : Array.from((graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })).segment(text), (part) => part.segment);
const ZERO_WIDTH = /^[\p{M}\p{Cf}\p{Cc}]+$/u;
const DOUBLE_WIDTH = new RegExp(
  '[\\u{1100}-\\u{115F}\\u{2329}-\\u{232A}\\u{2E80}-\\u{303E}\\u{3041}-\\u{33FF}\\u{3400}-\\u{4DBF}\\u{4E00}-\\u{9FFF}\\u{A000}-\\u{A4CF}\\u{A960}-\\u{A97F}\\u{AC00}-\\u{D7A3}\\u{F900}-\\u{FAFF}\\u{FE10}-\\u{FE19}\\u{FE30}-\\u{FE6F}\\u{FF00}-\\u{FF60}\\u{FFE0}-\\u{FFE6}\\u{FE0F}\\u{1B000}-\\u{1B2FF}\\u{20000}-\\u{3FFFD}]|\\p{Emoji_Presentation}|\\p{Regional_Indicator}',
  'u',
);
const cells = (grapheme: string) => (ZERO_WIDTH.test(grapheme) ? 0 : DOUBLE_WIDTH.test(grapheme) ? 2 : 1);
export const width = (text: string) =>
  SIMPLE.test(text) ? text.length : split(text).reduce((sum, grapheme) => sum + cells(grapheme), 0);
const pad = (text: string, n: number) => text + ' '.repeat(Math.max(0, n - width(text)));
// No separator left dangling before an ellipsis.
const ellipsis = (text: string) => text.replace(/[\s·,;:–—-]+$/u, '') + '…';

/** `text` in at most `n` cells; a cut ends in `…`, at a word boundary when one is near. */
export function fit(text: string, n: number): string {
  if (width(text) <= n) return text;
  if (n <= 0) return '';
  const parts = split(text);
  let used = 0;
  let kept = 0;
  while (kept < parts.length && used + cells(parts[kept]) <= n - 1) used += cells(parts[kept++]);
  let out = parts.slice(0, kept).join('');
  // Cut inside a word: back off to the last space when that keeps most of the room.
  if (!/^\s/u.test(parts[kept])) {
    const space = out.lastIndexOf(' ');
    if (space > 0 && width(out.slice(0, space)) >= (n - 1) * 0.6) out = out.slice(0, space);
  }
  return ellipsis(out);
}

/** The end of `text` in at most `n` cells, led by `…` when cut. */
export function tail(text: string, n: number): string {
  if (width(text) <= n) return text;
  if (n <= 0) return '';
  const parts = split(text);
  let used = 0;
  let from = parts.length;
  while (from > 0 && used + cells(parts[from - 1]) <= n - 1) used += cells(parts[--from]);
  return '…' + parts.slice(from).join('');
}

/**
 * Word-wrapped into lines of `n` cells. A word wider than a line is broken
 * across lines; a text needing more than `most` lines ends in `…`.
 */
export function wrap(text: string, n: number, most: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1;
    if (last >= 0 && width(lines[last]) + 1 + width(word) <= n) {
      lines[last] += ' ' + word;
      continue;
    }
    let line = '';
    for (const part of split(word)) {
      if (line && width(line) + cells(part) > n) {
        lines.push(line);
        line = '';
      }
      line += part;
    }
    lines.push(line);
  }
  if (lines.length <= most) return lines;
  const kept = lines.slice(0, most);
  const last = kept[most - 1];
  kept[most - 1] = width(last) < n ? ellipsis(last) : fit(last + ' …', n);
  return kept;
}

// SGR attributes; colour only where NO_COLOR and the terminal allow it.
type Style = { bold: string; dim: string; accent: string; version: string };
const RESET = '\x1b[0m';
const MONOCHROME = /^vt\d+$|-(m|mono)$/;
export function palette(env: NodeJS.ProcessEnv): Style {
  const color = !env.NO_COLOR && !MONOCHROME.test(env.TERM ?? '');
  // `version` marks the selected row's version as a filled chip; filled on
  // every row, chips in adjacent rows merge into one column.
  return { bold: '\x1b[1m', dim: '\x1b[2m', accent: color ? '\x1b[1;36m' : '\x1b[1m', version: color ? '\x1b[36;7m' : '\x1b[7m' };
}
const paint = (style: string, text: string) => (style && text ? style + text + RESET : text);
/** No attributes: measuring a panel line without its escapes. */
const PLAIN: Style = { bold: '', dim: '', accent: '', version: '' };

/** What is chosen, and how keys change it; nothing about drawing. */
export class Menu {
  readonly profiles: Profile[];
  readonly remembered: { profile: string; harness: string };
  readonly harnessCount: number;
  /** The profile whose harnesses the list shows. */
  activeIndex = 0;
  /** Cursor within the active profile's filtered harnesses. */
  index = 0;
  query = '';
  filtering = false;

  constructor(listing: Listing, remembered = '') {
    this.profiles = listing.profiles;
    const [profile, harness] = remembered.includes('/') ? remembered.split(/\/(.*)/) : ['', ''];
    this.remembered = { profile, harness };
    this.harnessCount = Math.max(...this.profiles.map((p) => p.harnesses.length));
    // A remembered choice only moves the cursor: the remembered profile is
    // active, with the cursor on its remembered harness, else the first of each.
    this.activeIndex = Math.max(0, this.profiles.findIndex((p) => p.name === profile));
    this.index = Math.max(0, this.active.harnesses.findIndex((h) => h.name === harness));
  }

  /** The profile the list shows. */
  get active(): Profile {
    return this.profiles[this.activeIndex];
  }

  rows(): Row[] {
    const query = this.query.toLowerCase();
    return this.active.harnesses.filter((r) => (r.title + ' ' + r.tagline).toLowerCase().includes(query));
  }

  /** The highlighted row, unless the filter leaves none. */
  current(): Row | undefined {
    return this.rows()[this.index];
  }

  /** Whether this is the remembered profile, or with `harness`, the remembered choice. */
  isRemembered(profile: string, harness = this.remembered.harness): boolean {
    return this.remembered.profile === profile && this.remembered.harness === harness;
  }

  /** Switch profile by `by` (cycling), the cursor on its remembered harness, else the first. */
  switchProfile(by: number) {
    this.activeIndex = (this.activeIndex + by + this.profiles.length) % this.profiles.length;
    this.query = '';
    this.filtering = false;
    this.index = Math.max(0, this.active.harnesses.findIndex((h) => this.isRemembered(this.active.name, h.name)));
  }

  /** Leave the filter with the cursor still on the row it was on. */
  clearFilter() {
    const current = this.current();
    this.query = '';
    this.filtering = false;
    this.index = Math.max(0, current ? this.active.harnesses.indexOf(current) : 0);
  }

  counts(): string {
    return `${this.active.harnesses.length} harnesses`;
  }

  /** The keys that do something now, as [key, what it does]. */
  keys(): [string, string][] {
    const profiles: [string, string][] = this.profiles.length > 1 ? [['←→', 'profile']] : [];
    if (this.filtering) return [['↑↓', 'move'], ['Enter', 'launch'], ...profiles, ['Esc', 'clear filter']];
    return [['↑↓ jk', 'move'], ...profiles, ['Enter', 'launch'], ['/', 'filter'], ['q', 'quit']];
  }

  /** Apply one key; a string ends the menu (empty to quit), undefined keeps going. */
  press(key: string): string | undefined {
    const rows = this.rows();
    const row = rows[this.index];
    const move = (by: number) => (this.index = (this.index + by + rows.length) % Math.max(1, rows.length));
    if (key === 'escape') {
      if (this.filtering) this.clearFilter();
      else return '';
    } else if (key === 'enter') {
      if (row) return this.active.name + '/' + row.name;
    } else if (key === 'tab' || key === 'right') {
      this.switchProfile(1);
    } else if (key === 'backtab' || key === 'left') {
      this.switchProfile(-1);
    } else if (key === 'down' || (key === 'j' && !this.filtering)) {
      move(1);
    } else if (key === 'up' || (key === 'k' && !this.filtering)) {
      move(-1);
    } else if (this.filtering) {
      if (key === 'backspace' && !this.query) this.filtering = false;
      else if (key === 'backspace') this.query = split(this.query).slice(0, -1).join('');
      // One character at a time; a ZWJ or variation selector joins the last.
      else if (split(key).length === 1 && !/\p{Cc}/u.test(key)) this.query += key;
      else return;
      this.index = 0;
    } else if (key === 'q') {
      return '';
    } else if (key === 'l') {
      this.switchProfile(1);
    } else if (key === 'h') {
      this.switchProfile(-1);
    } else if (key === '/') {
      this.filtering = true;
    }
  }
}

// '❯ ' pointer and '• ' remembered mark, then '✓ ' for the status mark.
const GUTTER = 4;
const MARK = 2;
// The panel wants PANEL_WANT cells and never gets less than PANEL_MIN while the
// box is drawn; beyond the longest tagline the box stops growing.
const PANEL_WANT = 30;
const PANEL_MIN = 24;

/** Where things go for the data and one terminal size: the box at (x, y), its columns and body height. */
export type Layout = { x: number; y: number; inner: number; list: number; panel: number; title: number; version: number; body: number; terminal: number };

/**
 * Widths come from the data: the list column is fixed by the titles and the
 * versions alone, so nothing the probes found can widen it; the panel takes the
 * rest. The box grows to the longest wrapped-free line — the longest tagline —
 * and wraps the panel beyond that, so nothing inside is ever cut.
 */
export function layout(menu: Menu, columns: number, rows: number): Layout | undefined {
  const all: Row[] = menu.profiles.flatMap((p) => p.harnesses);
  const longest = (texts: string[]) => Math.max(0, ...texts.map(width));
  const title = longest(all.map((h) => h.title));
  const version = longest(all.map((h) => h.version));
  const tagline = longest(all.map((h) => h.tagline));
  const list = GUTTER + MARK + title + 2 + version + 2;
  const room = columns - 4;
  if (room < list + 3 + PANEL_MIN) return undefined;
  const inner = Math.min(room, list + 3 + Math.max(PANEL_WANT, tagline + 2));
  const panel = inner - list - 3;
  // The body is as tall as the tallest panel at this width, so switching profile
  // never overflows it, and never shorter than the list.
  const body = Math.max(menu.harnessCount, ...menu.profiles.flatMap((p) => p.harnesses.map((h) => panelHeight(p, h, panel))));
  if (rows < body + 6 || inner + 4 < 8 + width(brand(menu)) + width(menu.counts()) + 1) return undefined;
  const x = columns - inner - 4 >= 2 ? 2 : 1;
  const y = rows >= body + 7 ? 2 : 1;
  return { x, y, inner, list, panel, title, version, body, terminal: columns };
}

const brand = (menu: Menu) => 'agent-distro' + (menu.profiles.length > 1 ? '' : ' · ' + menu.profiles[0].name);

/** The profile tabs, in menu order: the active one in accent, the remembered one dotted. */
function tabLine(menu: Menu, style: Style): string {
  return menu.profiles
    .map((p, i) => (menu.remembered.profile === p.name ? paint(style.accent, '• ') : '') + paint(i === menu.activeIndex ? style.accent : style.dim, p.name))
    .join(paint(style.dim, ' · '));
}

/** The tabs' width as drawn, without their escapes. */
const tabWidth = (menu: Menu) =>
  menu.profiles.reduce((sum, p) => sum + (menu.remembered.profile === p.name ? 2 : 0) + width(p.name), 0)
  + 3 * (menu.profiles.length - 1);

/** One list row, `l.list` cells wide: pointer, remembered mark, status mark, title, version chip. */
function listRow(row: Row, selected: boolean, remembered: boolean, l: Layout, style: Style): string {
  const mark = row.auth?.items.length ? paint(style.accent, '✓') : ' ';
  let text = (selected ? paint(style.accent, '❯') : ' ') + ' ' + (remembered ? paint(style.accent, '•') : ' ') + ' ' + mark + ' ';
  text += paint(selected ? style.bold : '', pad(row.title, l.title));
  // The chip ends the row, so the version keeps to the right edge.
  return text + '  ' + paint(selected ? style.version : '', ' ' + row.version.padStart(l.version) + ' ');
}

/** The panel's content for `row` in `profile`: the harness, then its auth status. */
function panelContent(profile: Profile, row: Row, panel: number, style: Style): string[] {
  const line = (text: string, style: string) => paint(style, pad(text, panel));
  const lines: string[] = [];
  for (const text of wrap(`${row.title} ${row.version}`, panel, Infinity)) lines.push(line(text, style.bold));
  for (const text of wrap(row.tagline, panel, Infinity)) lines.push(line(text, style.dim));
  lines.push(' '.repeat(panel));
  if (row.auth?.items.length) {
    lines.push(line('Signed in', ''));
    for (const item of row.auth.items) for (const text of wrap('  ' + item, panel, Infinity)) lines.push(line(text, ''));
  } else if (row.auth) {
    lines.push(line('Not signed in', style.dim));
  }
  return lines;
}

/** The profile line the panel keeps at its bottom. */
const panelDescription = (profile: Profile, panel: number, style: Style) =>
  wrap(`${profile.name} · ${profile.description}`, panel, Infinity).map((text) => paint(style.dim, pad(text, panel)));

/** How many lines `row`'s panel needs at `panel` cells: its content, a blank, and the profile line. */
const panelHeight = (profile: Profile, row: Row, panel: number) =>
  panelContent(profile, row, panel, PLAIN).length + 1 + panelDescription(profile, panel, PLAIN).length;

/** One frame for `menu` in `l`: per key, nothing re-solved. */
export function render(menu: Menu, l: Layout, style: Style): string {
  const { dim, bold, accent } = style;
  const edge = (text: string) => paint(dim, text);
  const lines: string[] = [];
  const row = (...cells: string[]) => lines.push(edge('│ ') + cells.join(edge(' │ ')) + edge(' │'));
  const blank = (n: number) => ' '.repeat(n);

  // Header: brand, the profile tabs, the harness count; the tabs give way on a
  // terminal too narrow for them, and the rule absorbs whatever is left.
  const name = brand(menu);
  const counts = menu.counts();
  const tabs = menu.profiles.length > 1 ? tabLine(menu, style) : '';
  let fill = l.inner - 4 - width(name) - width(counts) - (tabs ? tabWidth(menu) + 4 : 0);
  const shown = tabs && fill >= 1 ? tabs + edge(' ── ') : '';
  if (!shown) fill = l.inner - 4 - width(name) - width(counts);
  lines.push(edge('╭─ ') + paint(bold, 'agent-distro') + paint(dim, name.slice('agent-distro'.length)) + edge(' ' + '─'.repeat(fill) + ' ') + shown + counts + edge(' ─╮'));

  // The list, and beside it the panel: the highlighted harness, then the
  // profile line kept at the panel's bottom.
  const profile = menu.active;
  const current = menu.current();
  const filtered = menu.rows();
  const list = filtered.length
    ? filtered.map((r, i) => listRow(r, i === menu.index, menu.isRemembered(profile.name, r.name), l, style))
    : [paint(dim, pad('No matches', l.list))];
  const content = current ? panelContent(profile, current, l.panel, style) : [];
  // With no match there is nothing to describe, so the panel is blank.
  const description = current ? panelDescription(profile, l.panel, style) : [];
  const descriptionAt = l.body - description.length;
  for (let i = 0; i < l.body; i++) {
    const panel = i < content.length ? content[i] : i >= descriptionAt ? description[i - descriptionAt] : blank(l.panel);
    row(list[i] ?? blank(l.list), panel);
  }

  lines.push(edge('├' + '─'.repeat(l.list + 2) + '┴' + '─'.repeat(l.panel + 2) + '┤'));
  // The filter line: the query as typed and how many rows it leaves.
  let cursor = '\x1b[?25l';
  if (menu.filtering) {
    const n = filtered.length;
    const count = n === 1 ? '1 match' : n ? `${n} matches` : 'no matches';
    // Two cells for `/ `, two between the query and the count, one for the cursor.
    const query = tail(menu.query, l.inner - 5 - width(count));
    cursor = `\x1b[${l.y + lines.length};${l.x + 4 + width(query)}H\x1b[?25h`;
    row(paint(accent, '/') + ' ' + pad(query, l.inner - 2 - width(count)) + paint(dim, count));
  } else {
    row(paint(dim, pad('/ filter…', l.inner)));
  }
  lines.push(edge('╰' + '─'.repeat(l.inner + 2) + '╯'));

  // The footer, dropping the keys that do not fit before `q quit`.
  const keys = menu.keys();
  const footer = () => keys.reduce((sum, [k, what]) => sum + width(k) + 1 + width(what), 0) + 3 * (keys.length - 1);
  while (keys.length > 2 && footer() > l.terminal - l.x) keys.splice(-2, 1);
  lines.push(keys.map(([k, what]) => paint(bold, k) + ' ' + paint(dim, what)).join('   '));

  // Erase each line before drawing it: erasing after a line that ends in the
  // last column would take that column with it.
  return lines.map((line, i) => `\x1b[${l.y + i};${l.x}H\x1b[K${line}`).join('') + cursor;
}

// Leave the terminal as it was found however the process ends: a choice, a
// quit, a crash, or a signal. Set while the boxed view is up.
let restore = () => {};
process.on('exit', () => restore());
// Ctrl-C quits without a choice, as a key or as a signal; the others keep
// the conventional status for the shell to pass on.
for (const [signal, status] of [['SIGINT', 0], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  process.on(signal, () => process.exit(status));
}

function keyName(sequence: string, key?: Key): string | undefined {
  if (sequence === '\x1b') return 'escape';
  if (sequence === '\r' || sequence === '\n') return 'enter';
  if (sequence === '\t') return 'tab';
  if (sequence === '\x1b[Z') return 'backtab';
  if (sequence === '\x7f' || sequence === '\b') return 'backspace';
  // Other escape sequences (function keys) do nothing; the arrows are the ones
  // the menu uses.
  if (key?.code) return ['up', 'down', 'left', 'right'].includes(key.name ?? '') ? key.name : undefined;
  return sequence;
}

/**
 * The boxed view on the terminal `fd`, or undefined, before taking the
 * terminal over, when the box does not fit at start. Later, a terminal shrunk
 * too far shows a notice until it grows again.
 */
function draw(menu: Menu, fd: number, style: Style): Promise<string | undefined> {
  const input = process.stdin;
  const terminal = new WriteStream(fd);
  const fits = () => {
    const [columns, rows] = terminal.getWindowSize();
    return layout(menu, columns, rows);
  };
  let current = fits();
  if (!current) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    // Synchronized output, so a terminal shows each frame whole.
    const show = (clear: boolean) => {
      if (current) return terminal.write('\x1b[?2026h' + (clear ? '\x1b[H\x1b[2J' : '') + render(menu, current, style) + '\x1b[?2026l');
      const [columns, rows] = terminal.getWindowSize();
      const notice = wrap('Terminal too small for agent-distro: enlarge it, or press q to quit.', columns, rows);
      terminal.write('\x1b[?25l\x1b[H\x1b[2J' + notice.join('\r\n'));
    };
    // True once the menu has ended; keys already decoded are then ignored.
    let ended = false;
    const finish = (error: Error | null, choice = '') => {
      if (ended) return;
      ended = true;
      input.off('keypress', onKey);
      process.off('SIGWINCH', onResize);
      restore();
      input.pause();
      if (error) reject(error);
      else resolve(choice);
    };
    const dispatch = (name: string | undefined) => {
      if (ended || name === undefined) return;
      // Behind the notice the menu cannot be seen, so only quitting acts.
      if (!current) return name === 'q' ? finish(null) : undefined;
      const choice = menu.press(name);
      if (choice === undefined) show(false);
      else finish(null, choice);
    };
    const onKey = (character: string | undefined, key: Key) => {
      try {
        const sequence = key.sequence ?? character ?? '';
        if (key.ctrl && key.name === 'c') return finish(null);
        if (key.code && sequence.startsWith('\x1b\x1b')) {
          // Escape and then an arrow, read as one sequence.
          dispatch('escape');
          dispatch(keyName(sequence.slice(1), key));
        } else if (key.meta && !key.code && sequence.length > 1 && sequence.startsWith('\x1b')) {
          // An Escape that starts no known sequence arrives glued to the
          // keys after it: read it as Escape and then each of those keys.
          for (const part of ['\x1b', ...sequence.slice(1)]) dispatch(keyName(part));
        } else {
          dispatch(keyName(sequence, key));
        }
      } catch (error) {
        finish(error as Error);
      }
    };
    const onResize = () => {
      try {
        // getWindowSize() returns a size cached at construction, and Node
        // refreshes it on SIGWINCH for process.stdout and stderr only; this
        // stream, opened on /dev/tty, needs the same private call.
        (terminal as WriteStream & { _refreshSize(): void })._refreshSize();
        current = fits();
        show(true);
      } catch (error) {
        finish(error as Error);
      }
    };
    terminal.on('error', (error) => finish(error));
    // Generous enough for an arrow key split across packets over ssh.
    emitKeypressEvents(input, { escapeCodeTimeout: 100 });
    input.setRawMode(true);
    // Either step can fail on a terminal already gone; the other still runs.
    restore = () => {
      restore = () => {};
      try { input.setRawMode(false); } catch {}
      try { writeSync(fd, '\x1b[?25h\x1b[?1049l'); } catch {}
    };
    input.on('keypress', onKey);
    // A terminal that goes away (its PTY hung up) quits.
    input.once('end', () => finish(null));
    input.once('error', () => finish(null));
    process.on('SIGWINCH', onResize);
    input.resume();
    terminal.write('\x1b[?1049h');
    show(true);
  });
}

/** A numbered list on stderr, read a line at a time from stdin. */
async function plain(menu: Menu): Promise<string> {
  const lines = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const say = (text = '') => process.stderr.write(text + '\n');
  const many = menu.profiles.length > 1;
  // With several profiles the profile is picked first, as the boxed view's tabs are.
  let picking = many;
  for (;;) {
    const rows = picking ? [] : menu.rows();
    const count = picking ? menu.profiles.length : rows.length;
    const at = picking ? menu.activeIndex : menu.index;
    say('agent-distro · ' + (picking ? menu.counts() : menu.active.name));
    say(picking ? 'Profiles' : menu.active.description);
    say();
    if (picking) menu.profiles.forEach((p, i) => say(`${i + 1}. ` + p.name + '  ' + p.description));
    else rows.forEach((row, i) => say(`${i + 1}. ` + [row.title, row.tagline, row.auth?.text, row.version].filter(Boolean).join('  ')));
    process.stderr.write(picking ? `Pick a profile [${at + 1}], q quit: ` : `Launch [${at + 1}]${many ? ', h profiles' : ''}, q quit: `);
    const line = await lines.next();
    const value = line.done ? '' : line.value.trim();
    if (line.done || value === 'q' || value === '\x1b') return '';
    // As on the boxed view: h returns to the profiles.
    if (!picking && value === 'h' && many) {
      picking = true;
      continue;
    }
    const index = value ? Number(value) - 1 : at;
    if (!/^[0-9]*$/.test(value) || !(index >= 0 && index < count)) {
      say(`Not a choice: ${value}. Enter a number from 1 to ${count}${!picking && many ? ', h' : ''} or q.`);
      continue;
    }
    if (picking) {
      menu.activeIndex = index;
      menu.index = Math.max(0, menu.active.harnesses.findIndex((h) => menu.isRemembered(menu.active.name, h.name)));
      picking = false;
      continue;
    }
    return menu.active.name + '/' + rows[index].name;
  }
}

function usage(message: string): never {
  process.stderr.write(`choose.ts: ${message}\nusage: choose.ts MENU_JSON [--auth AUTH_JSON] [--profile NAME] [--remembered PROFILE/HARNESS]\n`);
  process.exit(2);
}

function parseArguments(args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { auth: { type: 'string' }, profile: { type: 'string' }, remembered: { type: 'string' } } });
  } catch (error) {
    usage((error as Error).message);
  }
  if (parsed.positionals.length !== 1) usage('expected one MENU_JSON argument');
  let listing: Listing;
  try {
    listing = parseListing(JSON.parse(parsed.positionals[0]));
  } catch (error) {
    usage(`MENU_JSON is not a listing: ${(error as Error).message}`);
  }
  let auth: Record<string, Spec> = {};
  if (parsed.values.auth !== undefined) {
    try {
      const value = JSON.parse(parsed.values.auth);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
      auth = value;
    } catch (error) {
      usage(`AUTH_JSON is not a probe map: ${(error as Error).message}`);
    }
  }
  return { listing, auth, profile: parsed.values.profile ?? '', remembered: parsed.values.remembered ?? '' };
}

/** The real readers behind `Io`: the files a harness reads, and a read-only SQLite query. */
const io: Io = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  sqlite: (path, sql) => {
    if (!existsSync(path)) return undefined;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare(sql).all();
    } finally {
      database.close();
    }
  },
};

/** The controlling terminal, or undefined when there is none to draw on. */
function openTerminal(): number | undefined {
  try {
    return openSync('/dev/tty', 'w');
  } catch (error) {
    if (['ENXIO', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

async function main() {
  const { listing, auth, profile, remembered } = parseArguments(process.argv.slice(2));
  if (profile) {
    listing.profiles = listing.profiles.filter((p) => p.name === profile);
    if (!listing.profiles.length) usage('unknown profile: ' + profile);
  }
  // Auth is a launch-time fact: probe every row once, before drawing.
  for (const p of listing.profiles) {
    // `Row` is the listing's harness plus the picker-only `auth`, which the listing never carries.
    const rows: Row[] = p.harnesses;
    for (const row of rows) {
      const spec = auth[`${p.name}/${row.name}`];
      if (spec) row.auth = probe(spec, process.env, io);
    }
  }
  const menu = new Menu(listing, remembered);
  const term = process.env.TERM ?? '';
  // The shell captures stdout for the result; the menu draws on the terminal.
  const fd = process.stdin.isTTY && term && term !== 'dumb' ? openTerminal() : undefined;
  let choice = fd === undefined ? undefined : await draw(menu, fd, palette(process.env));
  if (choice === undefined) {
    menu.clearFilter();
    choice = await plain(menu);
  }
  if (choice) writeSync(1, choice + '\n');
  process.exit(0);
}

if (import.meta.main) await main();
