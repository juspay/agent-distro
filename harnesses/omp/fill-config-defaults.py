"""Add absent wrapper defaults without replacing the user's own settings."""

import os
from pathlib import Path
import stat
import sys
import tempfile
from collections.abc import MutableMapping

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap


def fill_absent(target, defaults, path=""):
    """Add every default the user has not set, recursing into shared mappings.

    A key the user set is never replaced, mappings included: the recursion only
    reaches below it, and only for keys the user left out. So a config that
    already names every role and every display setting is not rewritten at all,
    while one that never mentioned them gets them back on the next launch.
    """
    added = 0
    for key, value in defaults.items():
        where = f"{path}{key}"
        if key not in target:
            target[key] = value
            added += 1
        elif isinstance(value, MutableMapping):
            # A section the user set to something else is a config error, not a
            # default to skip: OMP would read past it and silently run without
            # the settings under it — the roles among them.
            if not isinstance(target[key], MutableMapping):
                raise ValueError(f"{where} must be a YAML mapping")
            added += fill_absent(target[key], value, f"{where}.")
    return added


def fill_defaults(config, layers):
    """Fill absent keys from each layer, writing the config at most once."""
    # Follow a user's config symlink rather than replacing it.
    config = config.resolve()
    yaml = YAML()
    yaml.preserve_quotes = True
    exists = config.exists()
    original = config.read_text() if exists else ""
    data = yaml.load(original)
    preamble = ""
    if data is None:
        data = CommentedMap()
        # A comments-only document has no YAML node to retain its comments.
        if all(not line.strip() or line.lstrip().startswith("#") for line in original.splitlines()):
            preamble = original
            if preamble and not preamble.endswith("\n"):
                preamble += "\n"
    if not isinstance(data, MutableMapping):
        raise ValueError("config must be a YAML mapping")
    added = 0
    for layer in layers:
        added += fill_absent(data, layer)
    if not added:
        return
    config.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(config.stat().st_mode) if exists else 0o600
    fd, temporary = tempfile.mkstemp(prefix=".config-", dir=config.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(preamble)
            yaml.dump(data, stream)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, config)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    try:
        parser = YAML(typ="safe")
        # Files layer in order: a later file adds only keys the earlier ones
        # (and the user) left absent, so each default has one home.
        layers = [parser.load(Path(source)) for source in sys.argv[2:]]
        fill_defaults(Path(sys.argv[1]), [layer for layer in layers if layer])
    except OSError as error:
        # The defaults are a convenience; an agent directory the wrapper cannot
        # write must not stop the harness from launching.
        print(f"omp: warning: cannot fill config defaults in {sys.argv[1]}: {error}", file=sys.stderr)
    except Exception as error:
        sys.exit(f"omp: cannot fill config defaults in {sys.argv[1]}: {error}")
