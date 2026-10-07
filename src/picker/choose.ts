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

/** What is chosen, and how keys change it; nothing about drawing. */
export class Menu {
  readonly profiles: Profile[];
  /** The profile pane's rows, one per profile, in the same order. */
  readonly profileRows: Row[];
  readonly remembered: { profile: string; harness: string };
  readonly harnessCount: number;
  /** The profile whose harnesses have focus; null while profiles have focus. */
  profile: Profile | null = null;
  /** Cursor within the focused pane's filtered rows. */
  index = 0;
  query = '';
  filtering = false;

  constructor(listing: Listing, remembered = '') {
    this.profiles = listing.profiles;
    this.profileRows = this.profiles.map((p) => ({ name: p.name, title: p.name, tagline: p.description }));
    const [profile, harness] = remembered.includes('/') ? remembered.split(/\/(.*)/) : ['', ''];
    this.remembered = { profile, harness };
    this.harnessCount = Math.max(...this.profiles.map((p) => p.harnesses.length));
    // A remembered choice only moves the cursor: profiles still take focus
    // first whenever there is more than one. The first profile is the default.
    if (this.panes) this.focus(null, this.profiles.findIndex((p) => p.name === profile));
    else this.open(this.profiles[0]);
  }

  get panes() {
    return this.profiles.length > 1;
  }

  allRows(): Row[] {
    return this.profile ? this.profile.harnesses : this.profileRows;
  }

  rows(): Row[] {
    const query = this.query.toLowerCase();
    return this.allRows().filter((r) => (r.title + ' ' + r.tagline).toLowerCase().includes(query));
  }

  /** The profile whose harnesses the right pane shows. */
  shown(): Profile | undefined {
    return this.profile ?? this.profiles[this.profileRows.indexOf(this.rows()[this.index])];
  }

  /** Whether this is the remembered profile, or with `harness`, the remembered choice. */
  isRemembered(profile: string, harness = this.remembered.harness): boolean {
    return this.remembered.profile === profile && this.remembered.harness === harness;
  }

  /** Focus a pane, a profile's harnesses or (null) the profiles, with the cursor at `index` and no filter. */
  focus(profile: Profile | null, index: number) {
    this.profile = profile;
    this.index = Math.max(0, index);
    this.query = '';
    this.filtering = false;
  }

  /** Give a profile's harnesses focus, the cursor on its remembered one. */
  open(profile: Profile) {
    this.focus(profile, profile.harnesses.findIndex((h) => this.isRemembered(profile.name, h.name)));
  }

  back(): boolean {
    if (!this.profile || !this.panes) return false;
    this.focus(null, this.profiles.indexOf(this.profile));
    return true;
  }

  /** Enter on a row: a harness is the choice; a profile opens. */
  enter(row: Row): string | undefined {
    if (this.profile) return this.profile.name + '/' + row.name;
    this.open(this.profiles[this.profileRows.indexOf(row)]);
  }

  /** Leave the filter with the cursor still on the row it was on. */
  clearFilter() {
    const current = this.rows()[this.index];
    this.query = '';
    this.filtering = false;
    this.index = Math.max(0, this.allRows().indexOf(current));
  }

  counts(): string {
    return (this.panes ? `${this.profiles.length} profiles · ` : '') + `${this.harnessCount} harnesses`;
  }

  /** The keys that do something now, as [key, what it does]. */
  keys(): [string, string][] {
    const enter: [string, string] = ['Enter', this.profile ? 'launch' : 'pick profile'];
    const tab: [string, string][] = this.panes ? [['Tab', 'switch pane']] : [];
    if (this.filtering) return [['↑↓', 'move'], enter, ...tab, ['Esc', 'clear filter']];
    const back: [string, string][] = this.profile && this.panes ? [['←', 'profiles']] : [];
    return [['↑↓ jk', 'move'], enter, ...back, ...tab, ['/', 'filter'], ['q', 'quit']];
  }

  /** Apply one key; a string ends the menu (empty to quit), undefined keeps going. */
  press(key: string): string | undefined {
    const rows = this.rows();
    const row = rows[this.index];
    const move = (by: number) => (this.index = (this.index + by + rows.length) % Math.max(1, rows.length));
    if (key === 'escape') {
      if (this.filtering) this.clearFilter();
      else if (!this.back()) return '';
    } else if (key === 'enter') {
      if (row) return this.enter(row);
    } else if (key === 'tab') {
      if (this.profile) this.back();
      else if (row) this.enter(row);
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
    } else if (key === 'left' || key === 'h') {
      if (!this.back()) return '';
    } else if (key === '/') {
      this.filtering = true;
    }
  }
}

// Two cells of pointer and two of remembered mark lead every row.
const GUTTER = 4;

type Columns = { title: number; tagline: number; auth: number; version: number };
/** Where things go for the data and one terminal size: the box at (x, y), its panes' widths and rows. */
type Layout = { x: number; y: number; inner: number; left: number; right: number; columns: Columns; body: number; description: number; terminal: number };

/**
 * Widths come from the data: the box is as wide as its content wants and the
 * terminal allows. When it must narrow, the room descriptions were given
 * beyond the pane's base width goes first, then taglines, then the profile
 * pane down to its names.
 */
export function layout(menu: Menu, columns: number, rows: number): Layout | undefined {
  const all: Row[] = menu.profiles.flatMap((p) => p.harnesses);
  const longest = (texts: string[]) => Math.max(0, ...texts.map(width));
  const title = longest(all.map((h) => h.title));
  const version = longest(all.map((h) => h.version ?? ''));
  const tagline = longest(all.map((h) => h.tagline));
  // The auth column is as wide as the longest status, capped so one long email
  // cannot push the taglines and versions off the row.
  const auth = Math.min(24, longest(all.map((h) => h.auth?.text ?? '')));
  const names = longest(menu.profiles.map((p) => p.name));
  const body = menu.panes ? Math.max(menu.harnessCount, menu.profiles.length + 2) : menu.harnessCount;
  const description = body - menu.profiles.length - 1;
  // A harness row without its tagline: pointer, mark, title, auth and version
  // chip; `minimum` adds the auth column, `bare` is what a row keeps without it.
  const bare = GUTTER + title + 2 + version + 2;
  const minimum = bare + (auth ? 2 + auth : 0);
  const header = width(brand(menu)) + width(menu.counts()) + 8;
  const room = columns - 4;
  const wanted = Math.max(
    minimum + (tagline ? 2 + tagline : 0),
    menu.panes ? width('Harnesses · ') + names : width(menu.profiles[0].description),
  );
  // The profile pane: never narrower than its names, nor than the brand above
  // it (so the header has a place for the divider).
  const narrowest = Math.max(GUTTER + names, width('agent-distro') + 1);
  let left = 0;
  if (menu.panes) {
    const base = Math.max(narrowest, 20);
    left = base;
    while (left < 36 && menu.profiles.some((p) => wrap(p.description, left, Infinity).length > description)) left++;
    if (left + 3 + wanted > room) left = Math.max(base, room - 3 - wanted);
    if (left + 3 + minimum > room) left = Math.max(narrowest, room - 3 - minimum);
  }
  const inner = Math.min(room, Math.max(header - 4, menu.panes ? left + 3 + wanted : wanted));
  const right = menu.panes ? inner - left - 3 : inner;
  if (right < bare || inner + 4 < header || rows < body + 6) return undefined;
  // Taglines take the room left over, so version chips sit on the right edge;
  // the auth column gives way before the title and version, which a row keeps.
  const withAuth = auth > 0 && right >= minimum;
  const taglines = right - (withAuth ? minimum : bare) - 2;
  const x = columns - inner - 4 >= 2 ? 2 : 1;
  const y = rows >= body + 7 ? 2 : 1;
  return { x, y, inner, left, right, columns: { title, tagline: tagline && taglines >= 6 ? taglines : 0, auth: withAuth ? auth : 0, version }, body, description, terminal: columns };
}

const brand = (menu: Menu) => 'agent-distro' + (menu.panes ? '' : ' · ' + menu.profiles[0].name);

/**
 * One row of either pane, `n` cells wide: pointer, remembered mark and title,
 * then the tagline and version where the pane gives them columns.
 */
function listRow(row: Row, selected: boolean, focused: boolean, remembered: boolean, n: number, columns: Columns, style: Style): string {
  let text = (selected ? paint(focused ? style.accent : style.dim, '❯') : ' ') + ' ' + (remembered ? paint(style.accent, '•') : ' ') + ' ';
  text += paint(selected ? style.bold : '', pad(row.title, columns.title));
  if (columns.tagline) text += '  ' + paint(style.dim, pad(fit(row.tagline, columns.tagline), columns.tagline));
  if (columns.auth) {
    const cell = pad(fit(row.auth?.text ?? '', columns.auth), columns.auth);
    text += '  ' + (row.auth ? paint(row.auth.signedIn ? (selected ? style.accent : '') : style.dim, cell) : cell);
  }
  if (row.version === undefined) return text;
  // Slack goes before the chip, so versions keep to the right edge.
  const used = GUTTER + columns.title + (columns.tagline ? 2 + columns.tagline : 0) + (columns.auth ? 2 + columns.auth : 0);
  return text + ' '.repeat(n - used - columns.version - 4) + '  ' + paint(selected ? style.version : '', ' ' + row.version.padStart(columns.version) + ' ');
}

/** One frame for `menu` in `l`: per key, nothing re-solved. */
export function render(menu: Menu, l: Layout, style: Style): string {
  const { dim, bold, accent } = style;
  const edge = (text: string) => paint(dim, text);
  const lines: string[] = [];
  const row = (...cells: string[]) => lines.push(edge('│ ') + cells.join(edge(' │ ')) + edge(' │'));
  const blank = (n: number) => ' '.repeat(n);

  // Header: brand on the left, counts on the right, the pane divider between.
  const name = brand(menu);
  const counts = menu.counts();
  const fill = l.inner - 4 - width(name) - width(counts);
  let rule = '─'.repeat(fill);
  const divider = l.left - 1 - width(name);
  if (menu.panes && divider < fill) rule = rule.slice(0, divider) + '┬' + rule.slice(divider + 1);
  lines.push(edge('╭─ ') + paint(bold, 'agent-distro') + paint(dim, name.slice('agent-distro'.length)) + edge(' ' + rule + ' ') + counts + edge(' ─╮'));

  const shown = menu.shown();
  const filtered = menu.rows();
  // Either pane: the focused one's rows are filtered, and it shows when nothing matches.
  const pane = (rows: Row[], selected: number, focused: boolean, remembered: (row: Row) => boolean, n: number, columns: Columns) =>
    rows.length || !focused
      ? rows.map((r, i) => listRow(r, i === selected, focused, remembered(r), n, columns, style))
      : [paint(dim, pad('No matches', n))];
  const { profile } = menu;
  const harnesses = pane(profile ? filtered : (shown?.harnesses ?? []), profile ? menu.index : -1, !!profile,
    (h) => !!shown && menu.isRemembered(shown.name, h.name), l.right, l.columns);
  let profiles: string[] = [];
  if (menu.panes) {
    const heading = (text: string, focused: boolean, n: number) => paint(focused ? accent : dim, pad(fit(text, n), n));
    row(heading('Profiles', !profile, l.left), heading(shown ? 'Harnesses · ' + shown.name : 'Harnesses', !!profile, l.right));
    profiles = pane(profile ? menu.profileRows : filtered, profile ? menu.profiles.indexOf(profile) : menu.index, !profile,
      (p) => menu.isRemembered(p.name), l.left, { title: l.left - GUTTER, tagline: 0, auth: 0, version: 0 });
    // The description sits below every profile, filtered or not, so it never moves.
    while (profiles.length <= menu.profiles.length) profiles.push(blank(l.left));
    for (const line of shown ? wrap(shown.description, l.left, l.description) : []) profiles.push(paint(dim, pad(line, l.left)));
  } else {
    row(paint(dim, pad(fit(menu.profiles[0].description, l.right), l.right)));
  }
  for (let i = 0; i < l.body; i++) {
    row(...(menu.panes ? [profiles[i] ?? blank(l.left)] : []), harnesses[i] ?? blank(l.right));
  }

  lines.push(edge('├' + (menu.panes ? '─'.repeat(l.left + 2) + '┴' + '─'.repeat(l.right + 2) : '─'.repeat(l.inner + 2)) + '┤'));
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
  if (sequence === '\x7f' || sequence === '\b') return 'backspace';
  // Other escape sequences (right arrow, function keys) do nothing.
  if (key?.code) return ['up', 'down', 'left'].includes(key.name ?? '') ? key.name : undefined;
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
  for (;;) {
    const rows = menu.rows();
    const back = !!menu.profile && menu.panes;
    say('agent-distro · ' + (menu.profile ? menu.profile.name : menu.counts()));
    say(menu.profile ? menu.profile.description : 'Profiles');
    say();
    rows.forEach((row, i) => say(`${i + 1}. ` + [row.title, row.tagline, row.version, row.auth?.text].filter(Boolean).join('  ')));
    process.stderr.write(`${menu.profile ? 'Launch' : 'Pick a profile'} [${menu.index + 1}]${back ? ', h profiles' : ''}, q quit: `);
    const line = await lines.next();
    const value = line.done ? '' : line.value.trim();
    if (line.done || value === 'q' || value === '\x1b') return '';
    // As on the boxed view: h goes back, or quits with nowhere to go back to.
    if (value === 'h') {
      if (!menu.back()) return '';
      continue;
    }
    const index = value ? Number(value) - 1 : menu.index;
    if (!/^[0-9]*$/.test(value) || !(index >= 0 && index < rows.length)) {
      say(`Not a choice: ${value}. Enter a number from 1 to ${rows.length}${back ? ', h' : ''} or q.`);
      continue;
    }
    const choice = menu.enter(rows[index]);
    if (choice) return choice;
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

/** The real readers behind `Io`: the files a harness reads, and OMP's SQLite store. */
const io: Io = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  providers: (path) => {
    if (!existsSync(path)) return undefined;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare('SELECT provider FROM auth_credentials').all().map((row) =>
        typeof row === 'object' && row !== null && 'provider' in row ? String(row.provider) : '');
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
    // `Row` is `Harness` plus the picker-only `auth`, which the listing never carries.
    const rows = p.harnesses as Row[];
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
