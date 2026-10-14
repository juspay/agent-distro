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
    """`<job> (<os>)` for every runner each job of the cache workflow builds on.

    GitHub names a matrix job's check `<job> (<matrix value>)`, so the job id
    and its `matrix.os` list are the whole vocabulary. `just protect` reads the
    derived list rather than spelling it a second time: a rename in the workflow
    then reaches the ruleset through the next protect run, instead of quietly
    requiring a context nothing posts."""
    text = (root / WORKFLOW).read_text()
    if "\njobs:\n" not in text:
        sys.exit(f"{WORKFLOW}: no `jobs:` block, so no status contexts to derive")
    jobs = text.split("\njobs:\n", 1)[1]
    # A job is a key at two spaces; everything belonging to one is indented
    # deeper, so the block a job owns runs to the next such key (comments and
    # blank lines between jobs included in the one before).
    keys = list(re.finditer(r"^  (\S+):\s*$", jobs, re.M))
    if not keys:
        sys.exit(f"{WORKFLOW}: jobs: holds no job")
    found = []
    for position, key in enumerate(keys):
        end = keys[position + 1].start() if position + 1 < len(keys) else len(jobs)
        block = jobs[key.start():end]
        matrix = re.search(r"^\s+os:\s*\[([^\]]*)\]\s*$", block, re.M)
        if matrix is None:
            sys.exit(f"{WORKFLOW}: job {key.group(1)!r} has no inline `os: [...]` matrix to read")
        runners = [runner.strip() for runner in matrix.group(1).split(",")]
        if not all(runners):
            sys.exit(f"{WORKFLOW}: job {key.group(1)!r} names an empty runner: {runners}")
        found += [f"{key.group(1)} ({runner})" for runner in runners]
    return found


if "--contexts" in sys.argv[1:]:
    for context in contexts():
        print(context)
    sys.exit(0)

# The drift gate: the workflow must still resolve to jobs with an inline `os:`
# matrix. A restructure that leaves one unreadable fails here, in CI, rather
# than letting `protect` read a short context list and write it to the ruleset.
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
# What the publish job hands kolu's publish-closure action is a declaration
# file in this repository, because that job has no Nix until the action installs
# its own — the same reason flake.nix's `nixConfig` repeats lib/cache.nix. Its
# sources are the two files below, so what it says is checked against them here,
# in full, and the workflow must go on handing it over.
declaration = {
    "substituters": [cache["url"]],
    "trustedPublicKeys": [cache["publicKey"]],
    "index": {"repo": index["repo"], "branch": index["branch"]},
}
try:
    checked_in = json.loads((root / "binary-cache.json").read_text())
except (OSError, json.JSONDecodeError) as error:
    print(f"binary-cache.json: cannot be read as JSON: {error}", file=sys.stderr)
    failed = True
else:
    if checked_in != declaration:
        print(f"binary-cache.json is {checked_in}, but lib/cache.nix and lib/ca-index.nix "
              f"say {declaration}", file=sys.stderr)
        failed = True
workflow = (root / WORKFLOW).read_text()
sides = re.findall(r"^\s*sidecar:\s*(\S+)\s*$", workflow, re.M)
if sides != ["binary-cache.json"]:
    print(f"{WORKFLOW}: the action's sidecar is {sides}, not the checked-in binary-cache.json",
          file=sys.stderr)
    failed = True
# The site states the base URL for a reader consuming the index by hand, and is
# where a reader looks first: every one of them must be this index's.
urls = re.findall(r"https://raw\.githubusercontent\.com/juspay/agent-distro/\S*", (root / "doc/index.md").read_text())
if not urls:
    print("doc/index.md: names no content-addressed index URL", file=sys.stderr)
    failed = True
for url in urls:
    if not url.startswith(index["rawBase"]):
        print(f"doc/index.md: {url} is not under {index['rawBase']!r}", file=sys.stderr)
        failed = True

sys.exit(1 if failed else 0)
