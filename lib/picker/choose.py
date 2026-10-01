"""Draw a menu and return a choice; launching and persistence belong to ai."""
import curses
import json
import os
import sys


class TooSmall(Exception):
    pass


class Menu:
    def __init__(self, data):
        self.profiles = data['profiles']
        self.harnesses = data['harnesses']
        self.remembered = data.get('remembered', '')
        previous = self.remembered.split('/')
        self.profile = self.profiles[0] if len(self.profiles) == 1 else None
        self.index = next((i for i, p in enumerate(self.profiles)
                           if p['name'] == data['default']), 0)
        if len(previous) == 2:
            profile = next((p for p in self.profiles if p['name'] == previous[0]), None)
            index = next((i for i, h in enumerate(self.harnesses)
                          if h['name'] == previous[1]), None)
            if profile is not None and index is not None:
                self.profile, self.index = profile, index
        if len(self.profiles) == 1 and self.profile['name'] != previous[0]:
            self.index = 0
        self.query = ''
        self.filtering = False

    def rows(self):
        rows = self.harnesses if self.profile else self.profiles
        return [r for r in rows if self.query.casefold() in
                (r.get('title', r['name']) + ' ' +
                 r.get('tagline', r.get('description', ''))).casefold()]

    def select(self, row):
        if self.profile:
            return self.profile['name'] + '/' + row['name']
        self.profile, self.index = row, 0
        self.query, self.filtering = '', False

    def back(self):
        if self.profile and len(self.profiles) > 1:
            self.index = self.profiles.index(self.profile)
            self.profile = None
            self.query, self.filtering = '', False
            return True
        return False

    def draw(self, screen):
        curses.curs_set(0)
        curses.set_escdelay(25)
        while True:
            height, width = screen.getmaxyx()
            if height < 8 or width < 40:
                raise TooSmall
            screen.erase()
            header = self.profile['description'] if self.profile else 'Choose a profile'
            screen.addnstr(0, 0, header, width - 1)
            rows = self.rows()
            self.index = min(self.index, max(0, len(rows) - 1))
            title_width = max((len(r.get('title', r['name'])) for r in rows), default=0)
            count = height - 5
            start = max(0, self.index - count + 1)
            for y, row in enumerate(rows[start:start + count], 2):
                selected = start + y - 2 == self.index
                title = row.get('title', row['name'])
                detail = row.get('tagline', row.get('description', ''))
                version = row.get('version', '')
                marked = self.profile and self.remembered == self.profile['name'] + '/' + row['name']
                prefix = ('❯ ' if selected else '  ') + ('· ' if marked else '')
                right = width - len(version) - 2
                label = prefix + title.ljust(title_width) + '  '
                screen.addnstr(y, 0, label, max(1, right - 1), curses.A_BOLD if selected else 0)
                if len(label) < right - 1:
                    screen.addnstr(y, len(label), detail, right - len(label) - 1, curses.A_DIM)
                if version:
                    screen.addnstr(y, max(0, right), version, width - max(0, right) - 1)
            if not rows:
                screen.addstr(2, 2, 'No matches')
            screen.addnstr(height - 2, 0, '/' + self.query if self.filtering else
                           '↑/↓ j/k  Enter choose  ←/h back  / filter  q quit', width - 1, curses.A_DIM)
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
            print(self.profile['description'] if self.profile else 'Choose a profile', file=sys.stderr)
            for i, row in enumerate(rows, 1):
                print(f"{i}. {row.get('title', row['name'])}  "
                      f"{row.get('tagline', row.get('description', ''))}  "
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
    menu = Menu(json.loads(sys.argv[1]))
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
