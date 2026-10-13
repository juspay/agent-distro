#!/usr/bin/env python3
"""Write the index of published bundles: content-addressed on Linux, signed on macOS.

A user whose nix will not honour the project cache cannot fetch a bundle from
it at all: nix drops a non-trusted user's `extra-substituters`, their keys and
`--no-check-sigs` alike (`nix.conf` `require-sigs`). A content-addressed store
path is trusted by itself, so `nix copy` accepts one from that same cache
whatever the signature. This script does the rewrite CI cannot defer to the
user's machine, and writes the entries its updater and other consumers read:

    <directory>/<rev>/<system>/<profile>.json = {"ia": …, "ca": …}
    <directory>/latest/<system>/<profile>.json = {"rev": …, "ia": …, "ca": …}

**A Mac gets no such bundle.** The rewrite edits every file in the closure that
embeds a store path, and a Mach-O is one of them: the edit invalidates the
binary's ad-hoc signature, and arm64 macOS then kills it on exec. No re-signing
step can repair that — signing after rewriting would change the bytes again —
so a `*-darwin` entry names the signed bundle alone:

    <directory>/<rev>/<system>/<profile>.json = {"ia": …}
    <directory>/latest/<system>/<profile>.json = {"rev": …, "ia": …}

A Mac consumer copies that input-addressed path the way any signed bundle is
copied (the cache's key, or a trusted user), and the updater there takes its
ordinary skip where no cache this user's nix will honour holds it.

An updater on a revision looks its own entry up; `--latest`, which only a push
to the main branch passes, also names the newest bundle a system published, for
a consumer that wants that rather than the revision it is on.

The rewrite is all-new store paths, so the cache push that follows the job
uploads every one of them. Nothing here needs a cache: `nix store
make-content-addressed` reads the paths the job just built.

Usage: ca-index.py --rev REV --system SYSTEM --directory DIR [--latest] INSTALLABLE...
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


def bundle(nix_command: str, installable: str) -> str:
    """The bundle the installable builds, as its one store path."""
    paths = [line for line in nix(nix_command, ["build", "--no-link", "--print-out-paths", installable]).split() if line]
    if len(paths) != 1 or not STORE_PATH.match(paths[0]):
        sys.exit(f"ca-index: {installable}: nix build printed {paths}, not one store path")
    return paths[0]


def content_addressed(nix_command: str, ia: str) -> str:
    """`ia`'s content-addressed rewrite, checked against what the store says it is.

    The check is what the updater depends on: a path the cache holds unsigned is
    only usable where the store reads it as content-addressed.
    """
    rewrites = nix_json(nix_command, ["store", "make-content-addressed", "--json", ia]).get("rewrites")
    ca = rewrites.get(ia) if isinstance(rewrites, dict) else None
    if not isinstance(ca, str) or not STORE_PATH.match(ca):
        sys.exit(f"ca-index: nix rewrote no path for {ia}: {ca!r}")
    info = nix_json(nix_command, ["path-info", "--json-format", "1", "--json", ca])
    entry = info.get(ca) if isinstance(info, dict) else None
    if not isinstance(entry, dict) or not str(entry.get("ca") or "").startswith("fixed:"):
        sys.exit(f"ca-index: {ca} is not content-addressed in the store: {entry!r}")
    return ca


def write(path: pathlib.Path, value: dict) -> None:
    """One index entry: the JSON a consumer reads, in the directory it needs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rev", required=True, help="the revision the bundles were built from (the index's key)")
    parser.add_argument("--system", required=True, help="the system they were built for, e.g. x86_64-linux")
    parser.add_argument("--directory", required=True, type=pathlib.Path, help="the index tree to write into")
    parser.add_argument("--latest", action="store_true",
                        help="also name the newest bundle each profile published (a push to main only)")
    parser.add_argument("--nix", default="nix", help="the nix to run")
    parser.add_argument("installables", nargs="+", metavar="INSTALLABLE")
    args = parser.parse_args()
    for name, value in [("rev", args.rev), ("system", args.system)]:
        if not value or "/" in value or value.startswith("."):
            sys.exit(f"ca-index: {name} {value!r} cannot name a directory")
    # A rewritten Mach-O does not run on arm64 macOS (see the module docstring),
    # so those systems publish the signed bundle and nothing rewritten.
    signed_only = args.system.endswith("-darwin")
    for installable in args.installables:
        profile = installable.rsplit("#", 1)[-1]
        if not PROFILE.fullmatch(profile):
            sys.exit(f"ca-index: {installable}: {profile!r} is not a profile name")
        ia = bundle(args.nix, installable)
        entry = {"ia": ia}
        if signed_only:
            print(f"ca-index: {args.system}/{profile}.json: {ia} "
                  + "(signed: a rewritten Mach-O is killed on arm64 macOS)")
            published = f"{ia} (signed)"
        else:
            entry["ca"] = content_addressed(args.nix, ia)
            print(f'ca-index: {args.system}/{profile}.json: {ia} -> {entry["ca"]}')
            published = entry["ca"]
        write(args.directory / args.rev / args.system / f"{profile}.json", entry)
        if args.latest:
            # The revision beside the entry, so a consumer can tell whether
            # what it already has is what this names.
            write(args.directory / "latest" / args.system / f"{profile}.json", {"rev": args.rev, **entry})
            print(f"ca-index: latest/{args.system}/{profile}.json: {args.rev} -> {published}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
