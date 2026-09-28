"""Print every profile's npins revisions as one JSON object; never fetch."""
import json
from pathlib import Path


def main():
    pins = {}
    for sources in Path('profiles').glob('*/npins/sources.json'):
        profile = sources.parent.parent.name
        for name, pin in json.loads(sources.read_text())['pins'].items():
            pins[f'{profile}/{name}'] = pin['revision']
    print(json.dumps(pins, sort_keys=True))


if __name__ == '__main__':
    main()
