"""Decide whether Codex gets a launch-time `hide_agent_reasoning` default.

Reasoning blocks are hidden by default, but the setting is only passed when the
user has not chosen a value themselves: `-c` wins over `config.toml`, so an
unconditional override would silently undo an explicit `false` the user wrote.
"""
import os
import sys
import tomllib
from pathlib import Path

KEY = "hide_agent_reasoning"


def overrides(arguments):
    """Yield every TOML snippet the user passed via -c/--config."""
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        snippet = None
        if argument in ("-c", "--config"):
            if index + 1 < len(arguments):
                index += 1
                snippet = arguments[index]
        elif argument.startswith("--config="):
            snippet = argument[len("--config="):]
        elif argument.startswith("-c") and len(argument) > 2:
            snippet = argument[2:]
        if snippet is not None:
            try:
                yield tomllib.loads(snippet)
            except tomllib.TOMLDecodeError:
                pass
        index += 1


def sets_key(path):
    if not path.exists():
        return False
    try:
        return KEY in tomllib.loads(path.read_text())
    except (tomllib.TOMLDecodeError, OSError):
        # A broken config stops Codex itself; adding our own -c would only
        # obscure the error it reports.
        return True


def main(arguments):
    home = os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
    if sets_key(Path(home) / "config.toml"):
        return
    if any(KEY in snippet for snippet in overrides(arguments)):
        return
    print(f"{KEY}=true")


if __name__ == "__main__":
    main(sys.argv[1:])
