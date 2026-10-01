# Codex

Registers a store-built marketplace and installs plugins when its
store path changes. Steady launches preserve disabled/removed plugins; a new
build reinstalls them. Unrelated settings, credentials, and sessions persist.
Vanilla skips registration entirely. Local sessions default to `--no-daemon`
to avoid experimental background-server startup failures. The launcher does
not install, start, or update a shared server. Explicit `--remote` connections
and daemon-management subcommands remain available.
