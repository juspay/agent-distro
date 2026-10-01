"""Format the update PR from resolved versions; never fetch or change a pin."""
import json
import os
from pathlib import Path


def describe(name, before, after, release_url):
    if before == after:
        return [], f"**{name} unchanged (`{after}`)**"
    return [f"{name} {before} → {after}"], (
        f"**{name} `{before}` → `{after}`**\n\n"
        f"- release notes: {release_url}"
    )


def describe_pins(before, after):
    """One line per directory-local pin, keyed `<directory>/<pin>`.

    `npins update` moves pins; the two reads always see the same ones. Where a
    pin is — a release or a short revision — is read-pins.py's to say.
    """
    changes, lines = [], []
    for pin, old in sorted(before.items()):
        new = after[pin]
        if old["at"] == new["at"]:
            lines.append(f"- `{pin}` unchanged (`{old['at']}`)")
        else:
            changes.append(f"{pin} {old['at']} → {new['at']}")
            notes = f" — release notes: {new['notes']}" if "notes" in new else ""
            lines.append(f"- `{pin}` `{old['at']}` → `{new['at']}`{notes}")
    return changes, "**Source pins**\n\n" + "\n".join(lines)


def main():
    env = os.environ
    before = json.loads(env["VERSIONS_BEFORE"])
    after = json.loads(env["VERSIONS_AFTER"])
    metadata = json.loads(env["HARNESS_META"])
    changes, notes = [], []
    for name in sorted(after, key=lambda name: (metadata[name]["order"], name)):
        changed, note = describe(metadata[name]["title"], before.get(name, "added"),
                                 after[name], metadata[name]["releaseNotes"])
        changes.extend(changed)
        notes.append(note)
    pin_changes, pin_note = describe_pins(
        json.loads(env["PINS_BEFORE"]), json.loads(env["PINS_AFTER"]),
    )
    changes.extend(pin_changes)
    notes.append(pin_note)
    title = "chore(flake): update inputs"
    if changes:
        title += " (" + "; ".join(changes) + ")"
    run_url = f"{env['GITHUB_SERVER_URL']}/{env['GITHUB_REPOSITORY']}/actions/runs/{env['GITHUB_RUN_ID']}"
    temporary = Path(env["RUNNER_TEMP"])
    lock_log = (temporary / "flake-update.log").read_text().rstrip()
    body = temporary / "flake-update-body.md"
    body.write_text(
        "Automated input update.\n\n" + "\n\n".join(notes) + "\n\n"
        + f"```text\n{lock_log}\n```\n\n### CI on this PR\n\n"
        f"The [Update Flake]({run_url}) workflow approves the runs GitHub holds "
        "back for automation-created pull requests, waits for this pull request's "
        "checks — `build (ubuntu-latest)` and `build (macos-latest)`, the contexts "
        "`Require CI on main` expects — and squash-merges once they pass.\n"
    )
    with Path(env["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"pr-title={title}\npr-body-path={body}\n")


if __name__ == "__main__":
    main()
