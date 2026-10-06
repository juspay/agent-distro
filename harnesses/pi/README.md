# Pi

Merges plugin MCP servers and materialized skill paths into its user
JSON files, preserving personal entries, auth, and sessions. Gateway models
share OpenCode's fetch/cache; model defaults fill only absent settings. Every
profile defaults `hideThinkingBlock` to `true`; set it to `false` in
`settings.json` to show thinking blocks again.

A plugin on `AGENT_DISTRO_PLUGINS` is merged the same way, but for one launch:
the merge records what it added (and the profile servers it displaced) in
`.agent-distro-launch.json` in the agent directory, and the next merge removes
whatever is still as recorded before applying its own. Launches that run at
the same moment with different values can see each other's entries, since Pi
reads them from the same files.

The npins branch pin tracks `sadjow/pi-nix`. Its standalone binary packaging
recipe is called with the distribution's shared nixpkgs rather than the
packaging repo's own pin.
