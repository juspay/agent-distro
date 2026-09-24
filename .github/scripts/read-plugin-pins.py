"""Print every profile's npins revisions as one JSON object; never fetch."""
import json
from pathlib import Path


def main():
    pins = {}
    for sources in sorted(Path('profiles').glob('*/npins/sources.json')):
        profile = sources.parent.parent.name
        for name, pin in json.loads(sources.read_text())['pins'].items():
            # Git pins carry a revision; other kinds (PyPI, releases) carry a
            # version. Either way it is the string the update moves.
            revision = pin.get('revision') or pin.get('version')
            if revision is not None:
                pins[f'{profile}/{name}'] = revision
    print(json.dumps(pins, sort_keys=True))


if __name__ == '__main__':
    main()
