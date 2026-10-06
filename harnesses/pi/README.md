# Pi

Merges plugin MCP servers and materialized skill paths into its user
JSON files, preserving personal entries, auth, and sessions. Gateway models
share OpenCode's fetch/cache; model defaults fill only absent settings. Every
profile defaults `hideThinkingBlock` to `true`; set it to `false` in
`settings.json` to show thinking blocks again.

The npins branch pin tracks `sadjow/pi-nix`. Its standalone binary packaging
recipe is called with the distribution's shared nixpkgs rather than the
packaging repo's own pin.
