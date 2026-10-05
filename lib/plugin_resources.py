"""Materialize reader-approved resources shared by config-based adapters."""
from pathlib import Path
import re
import subprocess

from mcp_launcher import launcher


def copy_skills(description, skills):
    skills = Path(skills)
    for name, files in description['skills'].items():
        for file in files:
            target = skills / name / file
            target.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(['cp', '-L', '--', Path(description['root']) / 'skills' / name / file,
                            target], check=True)
    return str(skills) if description['skills'] else None


def write_launcher(description, name, server, root, index, bash, env):
    plugin = description['manifest']['name']
    script = Path(root) / 'bin' / f'{plugin}-{index}-{re.sub(r"[^A-Za-z0-9._-]", "_", name)}'
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(launcher(description, name, server, bash, env))
    script.chmod(0o700)
    return str(script)
