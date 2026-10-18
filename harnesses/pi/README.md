# Pi

Merges plugin MCP servers and materialized skill paths into its user
JSON files, preserving personal entries, auth, and sessions. A profile's
`env` is exported before Pi starts, and a `secret` variable it declares is
prompted for when it is not already set. Every profile defaults
`hideThinkingBlock` to `true`; set it to `false` in `settings.json` to show
thinking blocks again. Pi has no `settings.<harness>` of a profile to read:
its own files are where its providers live.

Each stdio MCP server runs through a generated launcher, in the directory the
harness was launched in (doc/index.md, "Working directory"). A plugin on
`AGENT_DISTRO_PLUGINS` is merged the same way, but for one launch:
the merge records what it added in `.agent-distro-launch.json` in the agent
directory, and the next merge removes
whatever is still as recorded before applying its own, so the entries stay
until the next `pi` launch, however much later that is. Without a home for
those files (`HOME` and `PI_CODING_AGENT_DIR` unset, or a directory it cannot
write), the launch fails rather than start without the plugins. Launches that run at
the same moment with different values can see each other's entries, since Pi
reads them from the same files. A profile read at launch (a `plugin.json` or an
`agent-distro.nix`) is merged as these are.

The npins branch pin tracks `sadjow/pi-nix`. Its standalone binary packaging
recipe is called with the distribution's shared nixpkgs rather than the
packaging repo's own pin.
