#!/usr/bin/env python3
"""Fail if flake.nix, CI or the site drift from lib/cache.nix and lib/ca-index.nix."""
import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]


def indexed(name):
    return json.loads(subprocess.check_output(
        ["nix", "eval", "--json", "--file", str(root / f"lib/{name}.nix")], text=True))


cache = indexed("cache")
expected = {
    "extra-substituters": cache["url"],
    "extra-trusted-public-keys": cache["publicKey"],
}
failed = False
for path in ["flake.nix", ".github/workflows/ci.yml"]:
    text = (root / path).read_text()
    for key, value in expected.items():
        found = re.findall(r"^\s*" + re.escape(key) + r"\s*=\s*\"?([^\"\n]+?)\"?;?\s*$", text, re.M)
        # CI sets it once per job that installs Nix with the cache.
        if not found or any(f != value for f in found):
            print(f"{path}: {key} is {found}, lib/cache.nix says {value!r}", file=sys.stderr)
            failed = True

index = indexed("ca-index")
# The workflow pushes the index to the branch lib/ca-index.nix names.
branches = re.findall(r"^\s*branch=(\S+)\s*$", (root / ".github/workflows/ci.yml").read_text(), re.M)
if branches != [index["branch"]]:
    print(f".github/workflows/ci.yml: pushes to {branches}, "
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
