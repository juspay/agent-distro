"""Decide whether Codex gets a launch-time `hide_agent_reasoning` default.

Reasoning blocks are hidden by default, but the setting is only passed when the
user has not chosen a value themselves. `-c` beats the config, and beats a
profile value too, so an unconditional override would silently undo an explicit
`false` left at the top level, in the active profile, or in that profile's
own `<name>.config.toml`.
"""
import os
import sys
import tomllib
from pathlib import Path

KEY = "hide_agent_reasoning"


def value_flags(arguments):
    """Yield (flag, value) for the flags that take a value and matter here."""
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument in ("-c", "--config", "-p", "--profile"):
            if index + 1 < len(arguments):
                index += 1
                yield argument, arguments[index]
            else:
                yield argument, None
        elif argument.startswith("--config="):
            yield "--config", argument[len("--config="):]
        elif argument.startswith("--profile="):
            yield "--profile", argument[len("--profile="):]
        elif argument.startswith("-c") and len(argument) > 2:
            yield "-c", argument[2:]
        elif argument.startswith("-p") and len(argument) > 2:
            yield "-p", argument[2:]
        index += 1


def config_overrides(arguments):
    """Yield the TOML snippets the user passed via -c/--config."""
    for flag, value in value_flags(arguments):
        if flag in ("-c", "--config") and value is not None:
            try:
                yield tomllib.loads(value)
            except tomllib.TOMLDecodeError:
                pass


def parse(path):
    """Parse a TOML file; None when absent, {} when Codex will report it."""
    try:
        return tomllib.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (tomllib.TOMLDecodeError, OSError):
        # A broken config stops Codex itself; adding our own -c would only
        # obscure the error it reports.
        return {}


def active_profile(arguments, document, overrides):
    for flag, value in value_flags(arguments):
        if flag in ("-p", "--profile") and value is not None:
            return value
    for override in overrides:
        if isinstance(override.get("profile"), str):
            return override["profile"]
    if isinstance(document.get("profile"), str):
        return document["profile"]
    return None


def chooses_key(home, document, profile):
    if KEY in document:
        return True
    if profile is None:
        return False
    profiles = document.get("profiles")
    if isinstance(profiles, dict):
        active = profiles.get(profile)
        if isinstance(active, dict) and KEY in active:
            return True
    layered = parse(home / f"{profile}.config.toml")
    return isinstance(layered, dict) and KEY in layered


def main(arguments):
    overrides = list(config_overrides(arguments))
    if any(KEY in override for override in overrides):
        return
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    document = parse(home / "config.toml")
    if document is None:
        document = {}
    if chooses_key(home, document, active_profile(arguments, document, overrides)):
        return
    print(f"{KEY}=true")


if __name__ == "__main__":
    main(sys.argv[1:])
