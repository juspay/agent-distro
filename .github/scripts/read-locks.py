"""Print where every flake lock's own inputs are, as one JSON object; never fetch.

Each lock owns what it declares: the root's is nixpkgs, and `test/`'s holds Home
Manager and the Juspay profile's sources, which nothing else locks. An input
that follows another is not a pin of its own — its position is the followed
one's, reported by whoever owns it — and neither is a `path:` input, whose
content is the checkout. What comes out is the shape read-pins.py prints, keyed
by the directory whose lock names the input.
"""
import json
from pathlib import Path

LOCKS = ['flake.lock', 'test/flake.lock', 'doc/flake.lock']


def position(node):
    """Where a locked node is: the revision it is on, or a fixed URL's file name."""
    locked = node.get('locked', {})
    if 'rev' in locked:
        return {'at': locked['rev'][:7]}
    if 'url' in locked:
        return {'at': locked['url'].rsplit('/', 1)[-1]}
    return None


def main():
    pins = {}
    for lock in LOCKS:
        path = Path(lock)
        if not path.is_file():
            continue
        data = json.loads(path.read_text())
        # `.` for the root lock, which is the flake's own directory.
        owner = path.parent.name or 'flake'
        for name, node in data['nodes'][data['root']].get('inputs', {}).items():
            if not isinstance(node, str):
                continue  # follows another input, whose own lock reports it
            at = position(data['nodes'][node])
            if at is not None:
                pins[f'{owner}/{name}'] = at
    print(json.dumps(pins, sort_keys=True))


if __name__ == '__main__':
    main()
