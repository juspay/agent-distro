"""Format the update PR from resolved versions; never fetch or change a pin."""
import json
import os
from pathlib import Path


def describe(name, before, after, release_url):
    if before == after:
        return [], f"**{name} unchanged (`{after}`)**"
    return [f"{name} {before} → {after}"], (
        f"**{name} `{before}` → `{after}`**\n\n"
        f"- release notes: {release_url}{after}"
    )


def describe_plugins(before, after):
    """One line per `profiles/<name>/npins` source, keyed `<profile>/<pin>`."""
    changes, lines = [], []
    for pin in sorted(set(before) | set(after)):
        old, new = before.get(pin), after.get(pin)
        if old == new:
            lines.append(f"- `{pin}` unchanged (`{old[:7]}`)")
        elif old is None:
            changes.append(f"{pin} {new[:7]}")
            lines.append(f"- `{pin}` pinned at `{new[:7]}`")
        elif new is None:
            changes.append(f"{pin} removed")
            lines.append(f"- `{pin}` removed (was `{old[:7]}`)")
        else:
            changes.append(f"{pin} {old[:7]} → {new[:7]}")
            lines.append(f"- `{pin}` `{old[:7]}` → `{new[:7]}`")
    if not lines:
        return changes, "**No plugin sources are pinned**"
    return changes, "**Plugin sources**\n\n" + "\n".join(lines)


def main():
    env = os.environ
    omp_changes, omp_note = describe(
        "oh-my-pi", env["OMP_BEFORE"], env["OMP_AFTER"],
        "https://github.com/can1357/oh-my-pi/releases/tag/",
    )
    if env["OMP_AFTER"] != env["OMP_LATEST"]:
        omp_note += f" — latest release is `{env['OMP_LATEST']}`; the pin only moves forward."
    codex_changes, codex_note = describe(
        "Codex", env["CODEX_BEFORE"], env["CODEX_AFTER"],
        "https://github.com/openai/codex/releases/tag/rust-v",
    )
    claude_changes, claude_note = describe(
        "Claude Code", env["CLAUDE_BEFORE"], env["CLAUDE_AFTER"],
        "https://github.com/anthropics/claude-code/releases/tag/v",
    )
    plugin_changes, plugin_note = describe_plugins(
        json.loads(env["PLUGINS_BEFORE"]), json.loads(env["PLUGINS_AFTER"]),
    )
    changes = omp_changes + codex_changes + claude_changes + plugin_changes
    title = "chore(flake): update inputs"
    if changes:
        title += " (" + "; ".join(changes) + ")"
    run_url = f"{env['GITHUB_SERVER_URL']}/{env['GITHUB_REPOSITORY']}/actions/runs/{env['GITHUB_RUN_ID']}"
    temporary = Path(env["RUNNER_TEMP"])
    lock_log = (temporary / "flake-update.log").read_text().rstrip()
    body = temporary / "flake-update-body.md"
    body.write_text(
        f"Automated flake input update.\n\n{omp_note}\n\n{codex_note}\n\n{claude_note}\n\n"
        f"{plugin_note}\n\n"
        "Codex packaging: https://github.com/sadjow/codex-cli-nix\n\n"
        "Claude Code packaging: https://github.com/sadjow/claude-code-nix\n\n"
        f"```text\n{lock_log}\n```\n\n### CI on this PR\n\n"
        f"The [Update Flake]({run_url}) workflow approves the runs GitHub holds "
        "back for automation-created pull requests, waits for this pull request's "
        "checks — `build (ubuntu-latest)` and `build (macos-latest)`, the contexts "
        "`Require CI on main` expects — and squash-merges once they pass.\n"
    )
    with Path(env["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"pr-title={title}\npr-body-path={body}\n")


if __name__ == "__main__":
    main()
