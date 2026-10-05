# Pi

Merges plugin MCP servers and materialized skill paths into its user
JSON files, preserving personal entries, auth, and sessions. Gateway models
share OpenCode's fetch/cache; model defaults fill only absent settings,
including `defaultThinkingLevel: "off"`, so a session starts with reasoning
disabled (Pi defaults to `medium`).

The npins branch pin tracks `sadjow/pi-nix`. Its standalone binary packaging
recipe uses the packaging repo’s pinned package set, preserving its upstream
derivation at the same revision.
