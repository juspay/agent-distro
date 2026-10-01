"""One atomic JSON writer, preserving the target's mode (0600 for new files).

Every adapter writes user-facing JSON through this: concurrent launches never
see a partially written file, and a launch never changes the permissions the
user's file already had.
"""
import json
import os
from pathlib import Path
import stat
import tempfile


def read_json(path):
    """The file's parsed JSON; missing file is None, invalid JSON raises."""
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return None


def write_json(path, data):
    path = Path(path).resolve()  # Follow a user symlink rather than replacing it.
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
