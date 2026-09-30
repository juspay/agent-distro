"""Add absent wrapper defaults to Pi's settings.json, preserving the rest."""
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def fill_absent(target, defaults):
    """Add every default the user has not set; a user key always wins."""
    added = 0
    for key, value in defaults.items():
        if key not in target:
            target[key] = value
            added += 1
    return added


def fill_defaults(settings_path, defaults):
    settings_path = Path(settings_path).resolve()  # Follow a user symlink.
    exists = settings_path.exists()
    if exists:
        try:
            data = json.loads(settings_path.read_text())
        except (ValueError, UnicodeDecodeError) as error:
            sys.exit(f'pi: cannot fill settings defaults in {settings_path}: {error}')
        if not isinstance(data, dict):
            sys.exit(f'pi: cannot fill settings defaults in {settings_path}: settings must be an object')
    else:
        data = {}
    if not fill_absent(data, defaults):
        return
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(settings_path.stat().st_mode) if exists else 0o600
    fd, temporary = tempfile.mkstemp(prefix='.settings-', dir=settings_path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, settings_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    defaults = json.loads(Path(sys.argv[2]).read_text())
    fill_defaults(sys.argv[1], defaults)