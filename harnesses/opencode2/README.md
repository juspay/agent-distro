# OpenCode v2 (`opencode2`)

Uses its own adapter and the shared model cache,
emits v2's `skills` array, `mcp.servers`, and `providers` configuration, and
adds `--standalone` only to interactive TUI launches so a shared background server
cannot supply another session's config. V2 has no small-model setting, so only
`model` is selected. For scripted runs use `opencode2 run --standalone`; for
inspection use `opencode2 api --standalone` because v2's `debug config` and
`mcp list` commands attach to the shared service.

`AGENT_DISTRO_PLUGINS` reaches it through OpenCode's adapter, in the v2 schema.

OpenCode v2 uses upstream’s prebuilt npm binaries because its Nix build is not
reliable yet. `update.py` advances `sources.json` from upstream’s installer
metadata (or npm’s `latest` dist-tag) only after all three platform downloads
succeed.
