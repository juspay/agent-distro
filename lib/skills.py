"""Materialise one plugin's reader-approved skill files under a build root."""
import subprocess
from pathlib import Path


def materialise(root, description):
    """Copy the description's approved skill files under root/skills/<plugin>
    and return that directory, the value a harness loads. Only reader-approved
    files, dereferenced (`cp -L`) as opencode's adapter does."""
    plugin = description['manifest']['name']
    target = Path(root) / 'skills' / plugin
    for name, files in description['skills'].items():
        for file in files:
            destination = target / name / file
            destination.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(['cp', '-L', '--', Path(description['root']) / 'skills' / name / file,
                            destination], check=True)
    return str(target)
