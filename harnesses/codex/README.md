# Codex

Registers a store-built marketplace and installs plugins when its
store path changes. Steady launches preserve disabled/removed plugins; a new
build reinstalls them. Unrelated settings, credentials, and sessions persist.
Vanilla skips registration entirely. Local sessions default to `--no-daemon`
to avoid experimental background-server startup failures, and pass
`hide_agent_reasoning=true` so reasoning blocks stay hidden; a value already
set in `config.toml`, or passed with `-c`, wins. The launcher does
not install, start, or update a shared server. Explicit `--remote` connections
and daemon-management subcommands remain available.

The npins branch pin tracks `sadjow/codex-cli-nix`. Its standalone binary
packaging recipe uses the packaging repo’s pinned package set, with the
`native` runtime, preserving its upstream derivation at the same revision.
