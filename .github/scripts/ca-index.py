#!/usr/bin/env python3
"""Rewrite profile bundles to content-addressed form and write the index CI publishes.

A user whose nix will not honour the project cache cannot fetch a bundle from
it at all: nix drops a non-trusted user's `extra-substituters`, their keys and
`--no-check-sigs` alike (`nix.conf` `require-sigs`). A content-addressed store
path is trusted by itself, so `nix copy` accepts one from that same cache
whatever the signature. This script does the rewrite CI cannot defer to the
user's machine, and writes the entry its updater reads:

    <directory>/<rev>/<system>/<profile>.json = {"ia": …, "ca": …}

The rewrite is all-new store paths, so the cache push that follows the job
uploads every one of them. Nothing here needs a cache: `nix store
make-content-addressed` reads the paths the job just built.

Usage: ca-index.py --rev REV --system SYSTEM --directory DIR INSTALLABLE...
       (INSTALLABLE is a flake attribute, e.g. `.#vanilla`.)
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys

# A profile name is a Nix attribute name; it names the index file, so nothing
# that could climb out of the directory is allowed through.
PROFILE = re.compile(r"[A-Za-z_][A-Za-z0-9_'-]*")
STORE_PATH = re.compile(r"/nix/store/[0-9a-z]{32}-")


def nix(nix_command: str, args: list) -> str:
    """What `nix ARGS` prints, or exit naming what nix said."""
    result = subprocess.run([nix_command, *args], capture_output=True, text=True)
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()
        sys.exit(f"ca-index: nix {' '.join(args)}: {detail[-1] if detail else result.returncode}")
    return result.stdout


def nix_json(nix_command: str, args: list) -> dict:
    """The JSON `nix ARGS` prints, or exit naming what nix said."""
    text = nix(nix_command, args)
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        sys.exit(f"ca-index: nix {' '.join(args)}: unreadable JSON: {error}")


def indexed(nix_command: str, installable: str) -> tuple:
    """The `(ia, ca)` pair of one bundle: its store path, and its content-addressed rewrite.

    Both are checked before they are published, because the updater waits for
    the cache to hold the one it reads and can do nothing with the other.
    """
    paths = [line for line in nix(nix_command, ["build", "--no-link", "--print-out-paths", installable]).split() if line]
    if len(paths) != 1 or not STORE_PATH.match(paths[0]):
        sys.exit(f"ca-index: {installable}: nix build printed {paths}, not one store path")
    ia = paths[0]
    rewrites = nix_json(nix_command, ["store", "make-content-addressed", "--json", ia]).get("rewrites")
    ca = rewrites.get(ia) if isinstance(rewrites, dict) else None
    if not isinstance(ca, str) or not STORE_PATH.match(ca):
        sys.exit(f"ca-index: {installable}: nix rewrote no path for {ia}: {ca!r}")
    # An entry the cache holds unsigned is only usable when nix reads it as
    # content-addressed; `nix path-info` is where the store says so.
    info = nix_json(nix_command, ["path-info", "--json-format", "1", "--json", ca])
    entry = info.get(ca) if isinstance(info, dict) else None
    if not isinstance(entry, dict) or not str(entry.get("ca") or "").startswith("fixed:"):
        sys.exit(f"ca-index: {installable}: {ca} is not content-addressed in the store: {entry!r}")
    return ia, ca


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rev", required=True, help="the revision the bundles were built from (the index's key)")
    parser.add_argument("--system", required=True, help="the system they were built for, e.g. x86_64-linux")
    parser.add_argument("--directory", required=True, type=pathlib.Path, help="the index tree to write into")
    parser.add_argument("--nix", default="nix", help="the nix to run")
    parser.add_argument("installables", nargs="+", metavar="INSTALLABLE")
    args = parser.parse_args()
    for name, value in [("rev", args.rev), ("system", args.system)]:
        if not value or "/" in value or value.startswith("."):
            sys.exit(f"ca-index: {name} {value!r} cannot name a directory")
    for installable in args.installables:
        profile = installable.rsplit("#", 1)[-1]
        if not PROFILE.fullmatch(profile):
            sys.exit(f"ca-index: {installable}: {profile!r} is not a profile name")
        ia, ca = indexed(args.nix, installable)
        path = args.directory / args.rev / args.system / f"{profile}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"ia": ia, "ca": ca}, indent=2) + "\n")
        print(f"ca-index: {args.system}/{profile}.json: {ia} -> {ca}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
