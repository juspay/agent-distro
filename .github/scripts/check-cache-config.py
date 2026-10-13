#!/usr/bin/env python3
"""Fail if flake.nix, CI or the site drift from lib/cache.nix and lib/ca-index.nix.

`--contexts` prints the status contexts the cache workflow posts, one per line,
and nothing else: the `protect` recipe depends on them, and they are derived
here because the workflow is the one place they are spelled."""

import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ".github/workflows/cache.yml"


def contexts():
    """`<job> (<os>)` for every runner the cache workflow's one job builds on.

    GitHub names a matrix job's check `<job> (<matrix value>)`, so the job id
    and its `matrix.os` list are the whole vocabulary. `just protect` reads the
    derived list rather than spelling it a second time: a rename in the workflow
    then reaches the ruleset through the next protect run, instead of quietly
    requiring a context nothing posts."""
    text = (root / WORKFLOW).read_text()
    if "\njobs:\n" not in text:
        sys.exit(f"{WORKFLOW}: no `jobs:` block, so no status contexts to derive")
    jobs = text.split("\njobs:\n", 1)[1]
    ids = re.findall(r"^  (\S+):", jobs, re.M)
    if len(ids) != 1:
        sys.exit(f"{WORKFLOW}: jobs: must hold exactly one job, found {ids}")
    matrix = re.search(r"^\s+matrix:\s*$(?:.*\n)*?^\s+os:\s*\[([^\]]*)\]\s*$", jobs, re.M)
    if matrix is None:
        sys.exit(f"{WORKFLOW}: the job has no inline `os: [...]` matrix to read")
    runners = [runner.strip() for runner in matrix.group(1).split(",")]
    if not all(runners):
        sys.exit(f"{WORKFLOW}: the os matrix names an empty runner: {runners}")
    return [f"{ids[0]} ({runner})" for runner in runners]


if "--contexts" in sys.argv[1:]:
    for context in contexts():
        print(context)
    sys.exit(0)

# The drift gate: the workflow must still resolve to one job with an inline
# `os:` matrix. A restructure that leaves it unreadable fails here, in CI, rather
# than letting `protect` read an empty context list and write it to the ruleset.
contexts()


def indexed(name):
    return json.loads(subprocess.check_output(
        ["nix", "eval", "--json", "--file", str(root / f"lib/{name}.nix")], text=True))


cache = indexed("cache")
expected = {
    "extra-substituters": cache["url"],
    "extra-trusted-public-keys": cache["publicKey"],
}
failed = False
for path in ["flake.nix", WORKFLOW]:
    text = (root / path).read_text()
    for key, value in expected.items():
        found = re.findall(r"^\s*" + re.escape(key) + r"\s*=\s*\"?([^\"\n]+?)\"?;?\s*$", text, re.M)
        # CI sets it once per job that installs Nix with the cache.
        if not found or any(f != value for f in found):
            print(f"{path}: {key} is {found}, lib/cache.nix says {value!r}", file=sys.stderr)
            failed = True

index = indexed("ca-index")
# The workflow pushes the index to the branch lib/ca-index.nix names.
branches = re.findall(r"^\s*branch=(\S+)\s*$", (root / WORKFLOW).read_text(), re.M)
if branches != [index["branch"]]:
    print(f"{WORKFLOW}: pushes to {branches}, "
          f"lib/ca-index.nix says {index['branch']!r}", file=sys.stderr)
    failed = True
# The site states the base URL for a reader consuming the index by hand, and
# is where a reader looks first: every one of them must be this index's.
urls = re.findall(r"https://raw\.githubusercontent\.com/juspay/agent-distro/\S*", (root / "doc/index.md").read_text())
if not urls:
    print("doc/index.md: names no content-addressed index URL", file=sys.stderr)
    failed = True
for url in urls:
    if not url.startswith(index["rawBase"]):
        print(f"doc/index.md: {url} is not under {index['rawBase']!r}", file=sys.stderr)
        failed = True

sys.exit(1 if failed else 0)
