# The README's demo: pick a harness, land in it. Re-record with `just demo`,
# which assembles doc/demo.gif from the frames this writes.
Output "doc/frames/"

Set Shell bash
Set FontSize 20
Set Width 1100
Set Height 300
Set Padding 30
Set WaitTimeout 120s

Type "AI_PROFILE=juspay XDG_STATE_HOME=$(mktemp -d) nix run github:juspay/agent-distro -- --version"
Sleep 500ms
Enter
Wait+Screen /Claude Code/
Sleep 1500ms
Down
Sleep 400ms
Down
Sleep 1s
Enter
Wait+Screen /\(Claude Code\)/
Sleep 3s
