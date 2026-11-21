# The website's demo: in a fresh copy of the template, open the picker, filter
# to one agent, and print its version. `just demo` sets up the scratch
# repository and the empty home this runs in, and assembles doc/demo.gif,
# doc/demo.png and doc/og.png from the frames this writes.
Output "doc/frames/"

Set Shell bash
Set FontSize 20
Set Width 1100
Set Height 440
Set Padding 30
Set WaitTimeout 60s

# The command typed below is the one users run. Here it runs the picker that
# `just demo` built from this checkout, so the take shows what this checkout
# draws.
Hide
Type `nix() { if [ "$1 $2" = "run github:juspay/agent-distro" ]; then shift 2; agent-distro "$@"; else command nix "$@"; fi; }; cd /tmp/agent-distro-demo/my-distribution && clear`
Enter
Wait
Show

Type "nix run github:juspay/agent-distro -- --version"
Sleep 500ms
Enter
Wait+Screen /Enter launch/
Sleep 1500ms
Type "/"
Sleep 400ms
Type@150ms "claude"
# doc/demo.png is the frame 4.6 seconds before the end: the list filtered to
# one agent, inside these two seconds. `just demo` cuts doc/og.png from it.
Sleep 2s
Enter
Wait+Screen /\(Claude Code\)/
Sleep 3s
