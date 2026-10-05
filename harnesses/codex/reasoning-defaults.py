"""Decide whether Codex gets a launch-time `hide_agent_reasoning` default.

Reasoning blocks are hidden by default, but the setting is only passed when the
user has not chosen a value themselves. `-c` beats the config, and beats a
profile value too, so an unconditional override would silently undo an explicit
`false` left at the top level, in the active profile, or in that profile's own
`<name>.config.toml`.
"""
import os
import sys
import tomllib
from pathlib import Path

KEY = "hide_agent_reasoning"


def parse(text):
    """Parse a TOML snippet, or None when it is not valid TOML."""
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return None


def read_toml(path):
    """Parse a TOML file, or None when it is absent or unreadable."""
    try:
        text = path.read_text()
    except OSError:
        return None
    return parse(text)


def from_cli(arguments):
    """What the command line says about the two config sources that matter.

    Returns the `-c/--config` TOML snippets and the `-p/--profile` name, both
    found in one pass so Codex's value-flag grammar lives in one place.
    """
    overrides, profile = [], None
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        flag, value = None, None
        if argument in ("-c", "--config", "-p", "--profile"):
            flag = argument
            if index + 1 < len(arguments):
                index += 1
                value = arguments[index]
        elif argument.startswith(("--config=", "--profile=")):
            flag, value = argument.split("=", 1)
        elif argument[:2] in ("-c", "-p") and len(argument) > 2:
            flag, value = argument[:2], argument[2:]
        if value is not None:
            if flag in ("-c", "--config"):
                snippet = parse(value)
                if snippet is not None:
                    overrides.append(snippet)
            elif flag in ("-p", "--profile"):
                profile = value
        index += 1
    return overrides, profile


def active_profile(cli_profile, overrides, document):
    """The profile Codex resolves: -p/--profile, -c profile=..., then the file."""
    if cli_profile is not None:
        return cli_profile
    for override in overrides:
        if isinstance(override.get("profile"), str):
            return override["profile"]
    declared = document.get("profile")
    return declared if isinstance(declared, str) else None


def chooses_key(home, document, profile):
    """True when a layer Codex reads for this launch sets the key."""
    if KEY in document:
        return True
    if profile is None:
        return False
    profiles = document.get("profiles")
    active = profiles.get(profile) if isinstance(profiles, dict) else None
    if isinstance(active, dict) and KEY in active:
        return True
    layered = read_toml(home / f"{profile}.config.toml")
    return isinstance(layered, dict) and KEY in layered


def main(arguments):
    overrides, cli_profile = from_cli(arguments)
    if any(KEY in override for override in overrides):
        return
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    document = read_toml(home / "config.toml") or {}
    profile = active_profile(cli_profile, overrides, document)
    if chooses_key(home, document, profile):
        return
    print(f"{KEY}=true")


if __name__ == "__main__":
    main(sys.argv[1:])
