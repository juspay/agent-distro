/**
 * Draw a menu and return a choice; launching and persistence belong to agent-distro.
 *
 * Usage: node choose.ts MENU_JSON [--profile NAME] [--remembered PROFILE/HARNESS]
 *
 * MENU_JSON is the `--list --json` value (src/listing.ts). Prints
 * `profile/harness` on stdout, or nothing when the user quits. The menu is
 * drawn on /dev/tty, since the shell captures stdout; a terminal too small or
 * unsupported for the boxed view gets a numbered list on stderr.
 */
import { openSync, writeSync } from 'node:fs';
import { emitKeypressEvents, createInterface, type Key } from 'node:readline';
import { WriteStream } from 'node:tty';
import { parseArgs } from 'node:util';
import { parseListing, type Listing, type Profile } from '../listing.ts';

type Row = { name: string; title: string; tagline: string; version?: string };

class TooSmall extends Error {}

const casefold = (text: string) => text.toLowerCase();
const isPrintable = (character: string) => /^[^\p{C}\p{Z}]$/u.test(character) || character === ' ';

// Terminal cells, approximately wcwidth: combining marks take none, East Asian
// wide characters and emoji take two.
const ZERO_WIDTH = /[\p{M}​-‏︀-️]/u;
const DOUBLE_WIDTH = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Emoji_Presentation}/u;
const cellWidth = (character: string) => (ZERO_WIDTH.test(character) ? 0 : DOUBLE_WIDTH.test(character) ? 2 : 1);
const width = (text: string) => [...text].reduce((sum, character) => sum + cellWidth(character), 0);
const pad = (text: string, n: number) => text + ' '.repeat(Math.max(0, n - width(text)));

/** `text` in at most `n` cells; a cut ends in `…`, at a word boundary when one is near. */
function fit(text: string, n: number): string {
  if (width(text) <= n) return text;
  if (n <= 0) return '';
  let out = '';
  let used = 0;
  for (const character of text) {
    if (used + cellWidth(character) > n - 1) break;
    out += character;
    used += cellWidth(character);
  }
  const space = out.lastIndexOf(' ');
  if (space > 0 && space >= (n - 1) * 0.6) out = out.slice(0, space);
  // No separator left dangling before the ellipsis.
  return out.replace(/[\s·,;:–—-]+$/u, '') + '…';
}

/** Word-wrapped into lines of `n` cells; a text needing more than `most` lines ends in `…`. */
function wrap(text: string, n: number, most: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1;
    if (last >= 0 && width(lines[last]) + 1 + width(word) <= n) lines[last] += ' ' + word;
    else lines.push(word);
  }
  if (lines.length <= most) return lines.map((line) => fit(line, n));
  const kept = lines.slice(0, most);
  kept[most - 1] = fit(lines.slice(most - 1).join(' '), n);
  return kept.map((line) => fit(line, n));
}

// SGR attributes; colour only where the terminal and NO_COLOR allow it. Only
// the selected row's version is a filled chip: filled on every row, adjacent
// chips merge into one column.
type Palette = { bold: string; dim: string; accent: string; chip: string; chipSelected: string };
const RESET = '\x1b[0m';
const MONOCHROME = /^(vt\d+|ansi)$|-(m|mono)$/;
export function palette(env: NodeJS.ProcessEnv): Palette {
  const color = !env.NO_COLOR && !MONOCHROME.test(env.TERM ?? '');
  return color
    ? { bold: '\x1b[1m', dim: '\x1b[2m', accent: '\x1b[1;36m', chip: '', chipSelected: '\x1b[36;7m' }
    : { bold: '\x1b[1m', dim: '\x1b[2m', accent: '\x1b[1m', chip: '', chipSelected: '\x1b[7m' };
}
const paint = (style: string, text: string) => (style && text ? style + text + RESET : text);

export class Menu {
  profiles: Profile[];
  /** The profile pane's rows, one per profile, in the same order. */
  profileRows: Row[];
  remembered: string;
  /** The profile whose harnesses have focus; null while profiles have focus. */
  profile: Profile | null;
  /** Cursor within the focused pane's filtered rows. */
  index: number;
  query = '';
  filtering = false;
  colors: Palette;

  constructor(data: Listing, remembered = '', colors = palette({})) {
    this.profiles = data.profiles;
    this.profileRows = this.profiles.map((p) => ({ name: p.name, title: p.name, tagline: p.description }));
    this.remembered = remembered;
    this.colors = colors;
    // A remembered choice only moves the cursor: profiles still take focus
    // first whenever there is more than one.
    this.profile = this.profiles.length === 1 ? this.profiles[0] : null;
    if (this.profile) {
      this.index = this.harnessIndex(this.profile);
    } else {
      const names = this.profiles.map((p) => p.name);
      const start = this.remembered.includes('/') ? this.remembered.split('/')[0] : data.default;
      this.index = Math.max(0, names.indexOf(start));
    }
  }

  allRows(): Row[] {
    return this.profile ? this.profile.harnesses : this.profileRows;
  }

  rows(): Row[] {
    return this.allRows().filter((r) => casefold(r.title + ' ' + r.tagline).includes(casefold(this.query)));
  }

  /** The profile whose harnesses the right pane shows. */
  shown(): Profile | undefined {
    return this.profile ?? this.profiles[this.profileRows.indexOf(this.rows()[this.index])];
  }

  /** The remembered harness under this profile, else the first row. */
  harnessIndex(profile: Profile): number {
    return Math.max(0, profile.harnesses.findIndex((h) => this.remembered === profile.name + '/' + h.name));
  }

  select(row: Row): string | undefined {
    if (this.profile) return this.profile.name + '/' + row.name;
    this.profile = this.profiles[this.profileRows.indexOf(row)];
    this.index = this.harnessIndex(this.profile);
    this.query = '';
    this.filtering = false;
  }

  back(): boolean {
    if (this.profile && this.profiles.length > 1) {
      this.index = this.profiles.indexOf(this.profile);
      this.profile = null;
      this.query = '';
      this.filtering = false;
      return true;
    }
    return false;
  }

  /** Leave the filter with the cursor still on the row it was on. */
  clearFilter() {
    const current = this.rows()[this.index];
    this.query = '';
    this.filtering = false;
    this.index = Math.max(0, this.allRows().indexOf(current));
  }

  banner(): string {
    if (this.profile) return ' · ' + this.profile.name;
    return ` · ${this.profiles.length} profiles · ${this.profiles[0].harnesses.length} harnesses`;
  }

  /** The keys that do something now, as [key, what it does]. */
  keys(): [string, string][] {
    const panes = this.profiles.length > 1;
    const enter: [string, string] = ['Enter', this.profile ? 'launch' : 'pick profile'];
    const tab: [string, string][] = panes ? [['Tab', 'switch pane']] : [];
    if (this.filtering) return [['↑↓', 'move'], enter, ...tab, ['Esc', 'clear filter']];
    const back: [string, string][] = this.profile && panes ? [['←', 'profiles']] : [];
    return [['↑↓ jk', 'move'], enter, ...back, ...tab, ['/', 'filter'], ['q', 'quit']];
  }

  /**
   * One full frame for a terminal of `height` rows and `width` columns, and
   * where the filter's cursor goes. Widths come from the data: the box is as
   * wide as its widest content, and only taglines and descriptions give way
   * when the terminal is narrower.
   */
  frame(height: number, width_: number): string {
    const { bold, dim, accent, chip, chipSelected } = this.colors;
    const twoPane = this.profiles.length > 1;
    const all = this.profiles.flatMap((p) => p.harnesses);
    const harnessCount = Math.max(...this.profiles.map((p) => p.harnesses.length));
    const titleWidth = Math.max(0, ...all.map((h) => width(h.title)));
    const versionWidth = Math.max(0, ...all.map((h) => width(h.version)));
    const chipWidth = versionWidth ? versionWidth + 2 : 0;
    const longestTagline = Math.max(0, ...all.map((h) => width(h.tagline)));
    const nameWidth = Math.max(...this.profiles.map((p) => width(p.name)));
    // Two cells of pointer and two of remembered mark lead every row.
    const gutter = 4;
    const bodyRows = twoPane ? Math.max(harnessCount, this.profiles.length + 2) : harnessCount;
    const descriptionRows = bodyRows - this.profiles.length - 1;
    const counts = twoPane ? `${this.profiles.length} profiles · ${harnessCount} harnesses` : `${harnessCount} harnesses`;
    const brand = 'agent-distro' + (twoPane ? '' : ' · ' + this.profiles[0].name);
    // A harness row without its tagline: pointer, mark, title and version chip.
    const harnessMinimum = gutter + titleWidth + (chipWidth ? 2 + chipWidth : 0);
    const headerMinimum = width(brand) + width(counts) + 8;
    // The narrowest profile pane that fits every description in its rows.
    const minimumLeft = Math.max(gutter + nameWidth, width('Profiles'));
    let left = minimumLeft;
    if (twoPane) {
      left = Math.max(left, 20);
      while (left < 36 && this.profiles.some((p) => wrap(p.description, left, Infinity).length > descriptionRows)) left++;
    }
    let wanted = harnessMinimum + (longestTagline ? 2 + longestTagline : 0);
    wanted = Math.max(wanted, twoPane ? width('Harnesses · ') + nameWidth : width(this.profiles[0].description));
    const boxWidth = Math.min(width_, Math.max(headerMinimum, (twoPane ? left + 3 + wanted : wanted) + 4));
    const inner = boxWidth - 4;
    // Narrower than wanted: taglines give way first, then the profile pane.
    if (twoPane && inner - left - 3 < harnessMinimum) left = Math.max(minimumLeft, inner - 3 - harnessMinimum);
    const right = twoPane ? inner - left - 3 : inner;
    if (right < harnessMinimum || boxWidth < headerMinimum || height < bodyRows + 6) throw new TooSmall();
    // Taglines take the room left over, so version chips sit on the right edge.
    let taglineWidth = longestTagline ? right - harnessMinimum - 2 : 0;
    if (taglineWidth < 6) taglineWidth = 0;
    const x = width_ - boxWidth >= 2 ? 2 : 1;
    const y = height >= bodyRows + 7 ? 2 : 1;

    const lines: string[] = [];
    // Borders are dim, so the rows inside them read first.
    const edge = (text: string) => paint(dim, text);
    const row = (...cells: string[]) => lines.push(edge('│ ') + cells.join(edge(' │ ')) + edge(' │'));

    // Header: brand on the left, counts on the right, the pane divider between.
    const fill = boxWidth - 8 - width(brand) - width(counts);
    let rule = '─'.repeat(fill);
    const divider = 2 + left + 1 - (4 + width(brand));
    if (twoPane && divider >= 0 && divider < fill) rule = rule.slice(0, divider) + '┬' + rule.slice(divider + 1);
    lines.push(edge('╭─ ') + paint(bold, 'agent-distro') + paint(dim, brand.slice('agent-distro'.length)) + edge(' ' + rule + ' ') + counts + edge(' ─╮'));

    const shown = this.shown();
    const filtered = this.rows();
    const harnessRows = this.profile ? filtered : (shown?.harnesses ?? []);
    if (twoPane) {
      const heading = (text: string, focused: boolean, n: number) => paint(focused ? accent : dim, pad(fit(text, n), n));
      row(heading('Profiles', !this.profile, left), heading(shown ? 'Harnesses · ' + shown.name : 'Harnesses', !!this.profile, right));
    } else {
      row(paint(dim, pad(fit(this.profiles[0].description, right), right)));
    }

    const pointer = (selected: boolean, focused: boolean) => (selected ? paint(focused ? accent : dim, '❯') : ' ');
    const mark = (remembered: boolean) => (remembered ? paint(accent, '•') : ' ');
    const description = shown ? wrap(shown.description, left, descriptionRows) : [];
    for (let i = 0; i < bodyRows; i++) {
      const cells: string[] = [];
      if (twoPane) {
        const profileRows = this.profile ? this.profileRows : filtered;
        const r = profileRows[i];
        if (r) {
          const selected = this.profile ? r.name === this.profile.name : i === this.index;
          const name = paint(selected ? bold : '', pad(r.name, left - gutter));
          cells.push(pointer(selected, !this.profile) + ' ' + mark(this.remembered.startsWith(r.name + '/')) + ' ' + name);
        } else if (i === 0 && !this.profile) {
          cells.push(paint(dim, pad('No matches', left)));
        } else if (i > this.profiles.length) {
          cells.push(paint(dim, pad(description[i - this.profiles.length - 1] ?? '', left)));
        } else {
          cells.push(' '.repeat(left));
        }
      }
      const h = harnessRows[i];
      if (h) {
        const selected = !!this.profile && i === this.index;
        const remembered = shown !== undefined && this.remembered === shown.name + '/' + h.name;
        let text = pointer(selected, true) + ' ' + mark(remembered) + ' ' + paint(selected ? bold : '', pad(h.title, titleWidth));
        if (taglineWidth) text += '  ' + paint(dim, pad(fit(h.tagline, taglineWidth), taglineWidth));
        if (chipWidth) text += '  ' + paint(selected ? chipSelected : chip, ' ' + h.version.padStart(versionWidth) + ' ');
        cells.push(text + ' '.repeat(right - harnessMinimum - (taglineWidth ? 2 + taglineWidth : 0)));
      } else if (i === 0 && this.profile) {
        cells.push(paint(dim, pad('No matches', right)));
      } else {
        cells.push(' '.repeat(right));
      }
      row(...cells);
    }

    lines.push(edge('├' + (twoPane ? '─'.repeat(left + 2) + '┴' + '─'.repeat(right + 2) : '─'.repeat(inner + 2)) + '┤'));
    // The filter line: the query as typed and how many rows it leaves.
    let cursor = 0;
    if (this.filtering) {
      const n = filtered.length;
      const count = n === 1 ? '1 match' : n ? `${n} matches` : 'no matches';
      const room = inner - 2 - width(count) - 2;
      const shownQuery = width(this.query) <= room ? this.query : '…' + [...this.query].slice(-(room - 1)).join('');
      cursor = 2 + width(shownQuery);
      row(paint(accent, '/') + ' ' + pad(shownQuery, inner - 2 - width(count)) + paint(dim, count));
    } else {
      row(paint(dim, pad('/ filter…', inner)));
    }
    lines.push(edge('╰' + '─'.repeat(inner + 2) + '╯'));

    // The footer, dropping the keys that do not fit before `q quit`.
    const keys = this.keys();
    const footerWidth = () => keys.reduce((sum, [k, what]) => sum + width(k) + 1 + width(what), 0) + 3 * (keys.length - 1);
    while (keys.length > 2 && footerWidth() > width_ - x) keys.splice(-2, 1);
    lines.push(keys.map(([k, what]) => paint(bold, k) + ' ' + paint(dim, what)).join('   '));

    let out = '\x1b[?2026h';
    lines.forEach((line, i) => (out += `\x1b[${y + i};${x}H${line}\x1b[K`));
    if (this.filtering) out += `\x1b[${y + lines.length - 3};${x + 2 + cursor}H\x1b[?25h`;
    else out += '\x1b[?25l';
    return out + '\x1b[?2026l';
  }

  /** Apply one key; a string ends the menu (empty to quit), undefined keeps going. */
  press(key: string): string | undefined {
    const rows = this.rows();
    const move = (by: number) => {
      const length = Math.max(1, rows.length);
      this.index = (this.index + by + length) % length;
    };
    if (key === 'escape') {
      if (this.filtering) this.clearFilter();
      else if (!this.back()) return '';
    } else if (key === 'enter') {
      if (rows.length) return this.select(rows[this.index]);
    } else if (key === 'tab') {
      if (this.profile) this.back();
      else if (rows.length) this.select(rows[this.index]);
    } else if (key === 'down') {
      move(1);
    } else if (key === 'up') {
      move(-1);
    } else if (this.filtering) {
      if (key === 'backspace' && !this.query) this.filtering = false;
      else if (key === 'backspace') this.query = this.query.slice(0, -1);
      else if ([...key].length === 1 && isPrintable(key)) this.query += key;
      else return;
      this.index = 0;
    } else if (key === 'q') {
      return '';
    } else if (key === 'left' || key === 'h') {
      if (!this.back()) return '';
    } else if (key === 'j') {
      move(1);
    } else if (key === 'k') {
      move(-1);
    } else if (key === '/') {
      this.filtering = true;
    }
  }

  /** The boxed view on the terminal; rejects with TooSmall to fall back. */
  draw(terminal: WriteStream): Promise<string> {
    const input = process.stdin;
    return new Promise((resolve, reject) => {
      const render = (clear = false) => {
        const [width, height] = terminal.getWindowSize();
        terminal.write((clear ? '\x1b[H\x1b[2J' : '') + this.frame(height, width));
      };
      // True once the menu has ended; keys already decoded are then ignored.
      let ended = false;
      const finish = (error: Error | null, choice = '') => {
        if (ended) return;
        ended = true;
        input.off('keypress', onKey);
        process.off('SIGWINCH', onResize);
        input.setRawMode(false);
        input.pause();
        terminal.write('\x1b[?25h\x1b[?1049l');
        if (error) reject(error);
        else resolve(choice);
      };
      const dispatch = (name: string | undefined) => {
        if (ended || name === undefined) return;
        const choice = this.press(name);
        if (choice === undefined) render();
        else finish(null, choice);
      };
      const keyName = (sequence: string, key?: Key) => {
        if (sequence === '\x1b') return 'escape';
        if (sequence === '\r' || sequence === '\n') return 'enter';
        if (sequence === '\t') return 'tab';
        if (sequence === '\x7f' || sequence === '\b') return 'backspace';
        // Other escape sequences (right arrow, function keys) do nothing.
        if (key?.code) return ['up', 'down', 'left'].includes(key.name ?? '') ? key.name : undefined;
        return sequence;
      };
      const onKey = (character: string | undefined, key: Key) => {
        try {
          const sequence = key.sequence ?? character ?? '';
          if (key.ctrl && key.name === 'c') return finish(null);
          // An Escape that starts no known sequence arrives glued to the keys
          // after it: read it as Escape and then each of those keys.
          if (key.meta && !key.code && sequence.length > 1 && sequence.startsWith('\x1b')) {
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
          // Node refreshes the cached size on SIGWINCH for process.stdout
          // only; this stream needs the same call.
          (terminal as WriteStream & { _refreshSize(): void })._refreshSize();
          render(true);
        } catch (error) {
          finish(error as Error);
        }
      };
      // A terminal too small from the start never enters the full screen.
      let first: string;
      try {
        const [width, height] = terminal.getWindowSize();
        first = this.frame(height, width);
      } catch (error) {
        return reject(error);
      }
      emitKeypressEvents(input, { escapeCodeTimeout: 25 });
      input.setRawMode(true);
      input.on('keypress', onKey);
      process.on('SIGWINCH', onResize);
      input.resume();
      terminal.write('\x1b[?1049h\x1b[H\x1b[2J' + first);
    });
  }

  /** A numbered list on stderr, read a line at a time from stdin. */
  async plain(): Promise<string> {
    const lines = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
    const say = (text = '') => process.stderr.write(text + '\n');
    for (;;) {
      const rows = this.rows();
      say('agent-distro' + this.banner());
      say(this.profile ? this.profile.description : 'Choose a profile');
      say();
      rows.forEach((row, i) => say(`${i + 1}. ${row.title}  ${row.tagline}  ${row.version ?? ''}`));
      process.stderr.write(`Choice [${this.index + 1}], h back, q quit: `);
      const line = await lines.next();
      const value = line.done ? '' : line.value.trim();
      if (line.done || value === 'q' || value === '\x1b') return '';
      if (value === 'h') {
        if (!this.back()) return '';
        continue;
      }
      if (value && !/^[+-]?[0-9]+$/.test(value)) continue;
      const index = value ? Number(value) - 1 : this.index;
      if (!(index >= 0 && index < rows.length)) continue;
      const choice = this.select(rows[index]);
      if (choice) return choice;
    }
  }
}

function usage(message: string): never {
  process.stderr.write(`choose.ts: ${message}\nusage: choose.ts MENU_JSON [--profile NAME] [--remembered PROFILE/HARNESS]\n`);
  process.exit(2);
}

function parseArguments(args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { profile: { type: 'string' }, remembered: { type: 'string' } } });
  } catch (error) {
    usage((error as Error).message);
  }
  if (parsed.positionals.length !== 1) usage('expected one MENU_JSON argument');
  let data: Listing;
  try {
    data = parseListing(JSON.parse(parsed.positionals[0]));
  } catch (error) {
    usage(`MENU_JSON is not a listing: ${(error as Error).message}`);
  }
  return { data, profile: parsed.values.profile ?? '', remembered: parsed.values.remembered ?? '' };
}

async function main() {
  const { data, profile, remembered } = parseArguments(process.argv.slice(2));
  if (profile) {
    data.profiles = data.profiles.filter((p) => p.name === profile);
    if (!data.profiles.length) usage('unknown profile: ' + profile);
  }
  const menu = new Menu(data, remembered, palette(process.env));
  // Ctrl-C quits without a choice, as a key or as a signal.
  process.on('SIGINT', () => process.exit(0));
  let choice: string;
  try {
    const term = process.env.TERM ?? '';
    if (!process.stdin.isTTY || !term || term === 'dumb') throw new TooSmall();
    // The shell captures stdout for the result; the menu draws on the terminal.
    choice = await menu.draw(new WriteStream(openSync('/dev/tty', 'w')));
  } catch (error) {
    if (!(error instanceof TooSmall) && !(error as NodeJS.ErrnoException).syscall) throw error;
    menu.query = '';
    menu.filtering = false;
    choice = await menu.plain();
  }
  if (choice) writeSync(1, choice + '\n');
  process.exit(0);
}

if (import.meta.main) await main();
