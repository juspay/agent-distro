/**
 * Draw a menu and return a choice; launching and persistence belong to agent-distro.
 *
 * Usage: node choose.ts MENU_JSON [--profile NAME] [--remembered PROFILE/HARNESS]
 *
 * Prints `profile/harness` on stdout, or nothing when the user quits. The menu
 * is drawn on /dev/tty, since the shell captures stdout; a terminal too small
 * or unsupported for the full-screen list gets a numbered list on stderr.
 */
import { openSync, writeSync } from 'node:fs';
import { emitKeypressEvents, createInterface, type Key } from 'node:readline';
import { WriteStream } from 'node:tty';
import { parseArgs } from 'node:util';

type Row = { name: string; title: string; tagline: string; version?: string };
type Profile = Row & { description: string };
type MenuData = {
  default: string;
  profiles: { name: string; description: string }[];
  harnesses: Row[];
  remembered?: string;
};

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

class TooSmall extends Error {}

const casefold = (text: string) => text.toLowerCase();
const isPrintable = (character: string) => /^[^\p{C}\p{Z}]$/u.test(character) || character === ' ';

export class Menu {
  profiles: Profile[];
  harnesses: Row[];
  remembered: string;
  profile: Profile | null;
  index: number;
  query = '';
  filtering = false;

  constructor(data: MenuData) {
    this.profiles = data.profiles.map((p) => ({ ...p, title: p.name, tagline: p.description }));
    this.harnesses = data.harnesses;
    this.remembered = data.remembered ?? '';
    // A remembered choice only moves the cursor: the profile screen still
    // shows whenever there is more than one profile.
    this.profile = this.profiles.length === 1 ? this.profiles[0] : null;
    if (this.profile) {
      this.index = this.harnessIndex(this.profile);
    } else {
      const names = this.profiles.map((p) => p.name);
      const start = this.remembered.includes('/') ? this.remembered.split('/')[0] : data.default;
      this.index = Math.max(0, names.indexOf(start));
    }
  }

  rows(): Row[] {
    const rows = this.profile ? this.harnesses : this.profiles;
    return rows.filter((r) => casefold(r.title + ' ' + r.tagline).includes(casefold(this.query)));
  }

  /** The remembered harness under this profile, else the first row. */
  harnessIndex(profile: Profile): number {
    return Math.max(0, this.harnesses.findIndex((h) => this.remembered === profile.name + '/' + h.name));
  }

  select(row: Row): string | undefined {
    if (this.profile) return this.profile.name + '/' + row.name;
    this.profile = row as Profile;
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

  banner(): string {
    if (this.profile) return ' · ' + this.profile.name;
    return ` · ${this.profiles.length} profiles · ${this.harnesses.length} harnesses`;
  }

  /** One full frame, curses-style: each text clipped to `n` characters at (y, x). */
  frame(height: number, width: number): string {
    if (height < 8 || width < 40) throw new TooSmall();
    let out = '\x1b[H\x1b[2J';
    const put = (y: number, x: number, text: string, n: number, attribute = '') => {
      out += `\x1b[${y + 1};${x + 1}H${attribute}${[...text].slice(0, Math.max(0, n)).join('')}${attribute && RESET}`;
    };
    put(0, 0, 'agent-distro', width - 1, BOLD);
    put(0, 'agent-distro'.length, this.banner(), width - 'agent-distro'.length - 1, DIM);
    put(1, 0, this.profile ? this.profile.description : 'Choose a profile', width - 1);
    const rows = this.rows();
    this.index = Math.min(this.index, Math.max(0, rows.length - 1));
    const titleWidth = Math.max(0, ...rows.map((r) => r.title.length));
    const count = height - 6;
    const start = Math.max(0, this.index - count + 1);
    rows.slice(start, start + count).forEach((row, offset) => {
      const y = offset + 3;
      const selected = start + offset === this.index;
      const version = row.version ?? '';
      const marked = this.profile && this.remembered === this.profile.name + '/' + row.name;
      const prefix = (selected ? '❯ ' : '  ') + (marked ? '· ' : '  ');
      const right = width - version.length - 2;
      const label = prefix + row.title.padEnd(titleWidth) + '  ';
      put(y, 0, label, Math.max(1, right - 1), selected ? BOLD : '');
      if (label.length < right - 1) put(y, label.length, row.tagline, right - label.length - 1, DIM);
      if (version) put(y, Math.max(0, right), version, width - Math.max(0, right) - 1);
    });
    if (!rows.length) put(3, 2, 'No matches', width - 3);
    let hints = 'Enter choose  / filter  q quit';
    if (this.profile) {
      const back = this.profiles.length > 1 ? '  ← back to profiles' : '';
      hints = '↑/↓ j/k  Enter choose' + back + '  / filter  q quit';
    }
    put(height - 2, 0, this.filtering ? '/' + this.query : hints, width - 1, DIM);
    return out;
  }

  /** Apply one key; a string ends the menu (empty to quit), undefined keeps going. */
  press(key: string): string | undefined {
    const rows = this.rows();
    if (key === 'escape') {
      if (this.filtering) {
        this.query = '';
        this.filtering = false;
        this.index = 0;
      } else if (!this.back()) {
        return '';
      }
    } else if (key === 'enter') {
      if (rows.length) return this.select(rows[this.index]);
    } else if (this.filtering) {
      if (key === 'backspace') this.query = this.query.slice(0, -1);
      else if ([...key].length === 1 && isPrintable(key)) this.query += key;
      this.index = 0;
    } else if (key === 'q') {
      return '';
    } else if (key === 'left' || key === 'h') {
      if (!this.back()) return '';
    } else if (key === 'down' || key === 'j') {
      this.index = (this.index + 1) % Math.max(1, rows.length);
    } else if (key === 'up' || key === 'k') {
      const length = Math.max(1, rows.length);
      this.index = (this.index - 1 + length) % length;
    } else if (key === '/') {
      this.filtering = true;
    }
  }

  /** The full-screen list on the terminal; rejects with TooSmall to fall back. */
  draw(terminal: WriteStream): Promise<string> {
    const input = process.stdin;
    return new Promise((resolve, reject) => {
      const render = () => {
        const [width, height] = terminal.getWindowSize();
        terminal.write(this.frame(height, width));
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
          // after it; curses reads it as Escape and then each of those keys.
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
          render();
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
      terminal.write('\x1b[?1049h\x1b[?25l' + first);
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
  let data: MenuData;
  try {
    data = JSON.parse(parsed.positionals[0]);
  } catch (error) {
    usage(`MENU_JSON is not JSON: ${(error as Error).message}`);
  }
  return { data, profile: parsed.values.profile ?? '', remembered: parsed.values.remembered };
}

async function main() {
  const { data, profile, remembered } = parseArguments(process.argv.slice(2));
  if (profile) {
    data.profiles = data.profiles.filter((p) => p.name === profile);
    if (!data.profiles.length) usage('unknown profile: ' + profile);
  }
  if (remembered !== undefined) data.remembered = remembered;
  const menu = new Menu(data);
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
