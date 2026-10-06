# The README's demo: pick a profile, filter to a harness, land in it.
# Re-record with `just demo`, which assembles doc/demo.gif from the frames
# this writes.
Output "doc/frames/"

Set Shell bash
Set FontSize 20
Set Width 1400
Set Height 460
Set Padding 30
Set WaitTimeout 120s

# Record this checkout, not the published flake: the command typed below is
# the one users run, and shows what it will draw once this checkout is on main.
Hide
Type `picker=$(nix build --no-link --print-out-paths . 2>/dev/null); nix() { if [ "$1 $2" = "run github:juspay/agent-distro" ]; then shift 2; "$picker/bin/agent-distro" "$@"; else command nix "$@"; fi; }; clear`
Enter
Wait
Show

Type "XDG_STATE_HOME=$(mktemp -d) nix run github:juspay/agent-distro -- --version"
Sleep 500ms
Enter
Wait+Screen /pick profile/
Sleep 1500ms
Down
Sleep 1200ms
Up
Sleep 800ms
Enter
Wait+Screen /Enter launch/
Sleep 1s
Type "/"
Sleep 400ms
Type@150ms "claude"
Sleep 1200ms
Enter
Wait+Screen /\(Claude Code\)/
Sleep 3s
