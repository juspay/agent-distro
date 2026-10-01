"""Draw a menu and return a choice; launching and persistence belong to agent-distro."""
import argparse
import curses
import json
import os
import sys


class TooSmall(Exception):
    pass


class Menu:
    def __init__(self, data):
        self.profiles = [dict(p, title=p['name'], tagline=p['description']) for p in data['profiles']]
        self.harnesses = data['harnesses']
        self.remembered = data.get('remembered', '')
        # A remembered choice only moves the cursor: the profile screen still
        # shows whenever there is more than one profile.
        self.profile = self.profiles[0] if len(self.profiles) == 1 else None
        if self.profile:
            self.index = self.harness_index(self.profile)
        else:
            names = [p['name'] for p in self.profiles]
            start = self.remembered.split('/', 1)[0] if '/' in self.remembered else data['default']
            self.index = names.index(start) if start in names else 0
        self.query = ''
        self.filtering = False

    def rows(self):
        rows = self.harnesses if self.profile else self.profiles
        return [r for r in rows if self.query.casefold() in
                (r['title'] + ' ' + r['tagline']).casefold()]

    def harness_index(self, profile):
        """The remembered harness under this profile, else the first row."""
        for index, harness in enumerate(self.harnesses):
            if self.remembered == profile['name'] + '/' + harness['name']:
                return index
        return 0

    def select(self, row):
        if self.profile:
            return self.profile['name'] + '/' + row['name']
        self.profile, self.index = row, self.harness_index(row)
        self.query, self.filtering = '', False

    def back(self):
        if self.profile and len(self.profiles) > 1:
            self.index = self.profiles.index(self.profile)
            self.profile = None
            self.query, self.filtering = '', False
            return True
        return False

    def banner(self):
        if self.profile:
            return ' · ' + self.profile['name']
        return f' · {len(self.profiles)} profiles · {len(self.harnesses)} harnesses'

    def draw(self, screen):
        curses.curs_set(0)
        curses.set_escdelay(25)
        while True:
            height, width = screen.getmaxyx()
            if height < 8 or width < 40:
                raise TooSmall
            screen.erase()
            screen.addnstr(0, 0, 'agent-distro', width - 1, curses.A_BOLD)
            screen.addnstr(0, len('agent-distro'), self.banner(),
                           width - len('agent-distro') - 1, curses.A_DIM)
            header = self.profile['description'] if self.profile else 'Choose a profile'
            screen.addnstr(1, 0, header, width - 1)
            rows = self.rows()
            self.index = min(self.index, max(0, len(rows) - 1))
            title_width = max((len(r['title']) for r in rows), default=0)
            count = height - 6
            start = max(0, self.index - count + 1)
            for y, row in enumerate(rows[start:start + count], 3):
                selected = start + y - 3 == self.index
                version = row.get('version', '')
                marked = self.profile and self.remembered == self.profile['name'] + '/' + row['name']
                prefix = ('❯ ' if selected else '  ') + ('· ' if marked else '  ')
                right = width - len(version) - 2
                label = prefix + row['title'].ljust(title_width) + '  '
                screen.addnstr(y, 0, label, max(1, right - 1), curses.A_BOLD if selected else 0)
                if len(label) < right - 1:
                    screen.addnstr(y, len(label), row['tagline'], right - len(label) - 1, curses.A_DIM)
                if version:
                    screen.addnstr(y, max(0, right), version, width - max(0, right) - 1)
            if not rows:
                screen.addstr(3, 2, 'No matches')
            hints = 'Enter choose  / filter  q quit'
            if self.profile:
                back = '  ← back to profiles' if len(self.profiles) > 1 else ''
                hints = '↑/↓ j/k  Enter choose' + back + '  / filter  q quit'
            screen.addnstr(height - 2, 0, '/' + self.query if self.filtering else
                           hints, width - 1, curses.A_DIM)
            screen.refresh()
            key = screen.get_wch()
            # Some PTY clients send normal-mode arrows despite keypad mode.
            if key == '\x1b':
                trailing = []
                screen.timeout(25)
                try:
                    trailing.append(screen.get_wch())
                    if trailing[0] in ('[', 'O'):
                        trailing.append(screen.get_wch())
                except curses.error:
                    pass
                finally:
                    screen.timeout(-1)
                arrow = {'A': curses.KEY_UP, 'B': curses.KEY_DOWN, 'D': curses.KEY_LEFT}
                if len(trailing) == 2 and trailing[0] in ('[', 'O') and trailing[1] in arrow:
                    key = arrow[trailing[1]]
                else:
                    for character in reversed(trailing):
                        curses.unget_wch(character)
            if key == '\x1b':
                if self.filtering:
                    self.query, self.filtering, self.index = '', False, 0
                elif not self.back():
                    return ''
            elif key in ('\n', '\r', curses.KEY_ENTER):
                if rows:
                    choice = self.select(rows[self.index])
                    if choice:
                        return choice
            elif self.filtering:
                if key in (curses.KEY_BACKSPACE, '\x7f', '\b'):
                    self.query = self.query[:-1]
                elif isinstance(key, str) and key.isprintable():
                    self.query += key
                self.index = 0
            elif key == 'q':
                return ''
            elif key in (curses.KEY_LEFT, 'h'):
                if not self.back():
                    return ''
            elif key in (curses.KEY_DOWN, 'j'):
                self.index = (self.index + 1) % max(1, len(rows))
            elif key in (curses.KEY_UP, 'k'):
                self.index = (self.index - 1) % max(1, len(rows))
            elif key == '/':
                self.filtering = True

    def plain(self):
        while True:
            rows = self.rows()
            print('agent-distro' + self.banner(), file=sys.stderr)
            print(self.profile['description'] if self.profile else 'Choose a profile', file=sys.stderr)
            print(file=sys.stderr)
            for i, row in enumerate(rows, 1):
                print(f"{i}. {row['title']}  {row['tagline']}  "
                      f"{row.get('version', '')}", file=sys.stderr)
            print(f'Choice [{self.index + 1}], h back, q quit: ', end='', file=sys.stderr, flush=True)
            line = sys.stdin.readline()
            if not line or line.strip() in ('q', '\x1b'):
                return ''
            value = line.strip()
            if value == 'h':
                if not self.back():
                    return ''
                continue
            try:
                index = int(value) - 1 if value else self.index
                if not 0 <= index < len(rows):
                    continue
            except ValueError:
                continue
            choice = self.select(rows[index])
            if choice:
                return choice


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('menu', type=json.loads)
    parser.add_argument('--profile', default='')
    parser.add_argument('--remembered', default=None)
    args = parser.parse_args()
    data = args.menu
    if args.profile:
        data['profiles'] = [p for p in data['profiles'] if p['name'] == args.profile]
        if not data['profiles']:
            parser.error('unknown profile: ' + args.profile)
    if args.remembered is not None:
        data['remembered'] = args.remembered
    menu = Menu(data)
    # Shell captures stdout for the result; curses must draw on the terminal.
    output = os.dup(1)
    try:
        try:
            with open('/dev/tty', 'w') as terminal:
                os.dup2(terminal.fileno(), 1)
                choice = curses.wrapper(menu.draw)
        except (curses.error, OSError, TooSmall):
            os.dup2(output, 1)
            menu.query, menu.filtering = '', False
            choice = menu.plain()
    except KeyboardInterrupt:
        choice = ''
    finally:
        os.dup2(output, 1)
        os.close(output)
    if choice:
        print(choice)


if __name__ == '__main__':
    main()
