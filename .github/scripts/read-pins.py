"""Print where every profile, harness, and shared npins pin is, as one JSON object; never fetch.

npins' file format stays in here. What comes out is what a reader of the
update calls a pin's position: the release it is on, or a short revision when
it follows a branch.
"""
import json
from pathlib import Path


def position(pin):
    if pin['type'] == 'GitRelease':
        repository = pin['repository']
        at = {'at': pin['version']}
        if repository['type'] == 'GitHub':
            at['notes'] = ('https://github.com/{owner}/{repo}/releases/tag/'.format(**repository)
                           + pin['version'])
        return at
    if pin['type'] == 'Url':
        # A fixed tarball, such as an npm release: its file name says where it is.
        return {'at': pin['url'].rsplit('/', 1)[-1]}
    return {'at': pin['revision'][:7]}


def main():
    pins = {}
    for sources in [*Path('profiles').glob('*/npins/sources.json'),
                    *Path('harnesses').glob('*/npins/sources.json'),
                    *Path('lib').glob('npins/sources.json')]:
        profile = sources.parent.parent.name
        for name, pin in json.loads(sources.read_text())['pins'].items():
            pins[f'{profile}/{name}'] = position(pin)
    print(json.dumps(pins, sort_keys=True))


if __name__ == '__main__':
    main()
