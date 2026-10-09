#!/usr/bin/env python3
"""Fail if flake.nix's nixConfig or CI's nix config drift from lib/cache.nix."""
import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]
cache = json.loads(subprocess.check_output(
    ["nix", "eval", "--json", "--file", str(root / "lib/cache.nix")], text=True))

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
sys.exit(1 if failed else 0)
