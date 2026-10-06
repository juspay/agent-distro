# Codex

Registers a store-built marketplace and installs plugins when its
store path changes. Steady launches preserve disabled/removed plugins; a new
build reinstalls them. Unrelated settings, credentials, and sessions persist.
Vanilla skips registration entirely. Local sessions default to `--no-daemon`
to avoid experimental background-server startup failures. The launcher does
not install, start, or update a shared server. Explicit `--remote` connections
and daemon-management subcommands remain available.

A plugin on `AGENT_DISTRO_PLUGINS` is never registered in `config.toml`. It gets
a one-plugin marketplace in the cache, named `agent-distro-<hash of its cache
key>`; Codex's own `plugin add` copies it into `$CODEX_HOME/plugins/cache`
through a throwaway `CODEX_HOME` whose `plugins` is the real one, and each
launch passes `-c` overrides that register that marketplace, enable the plugin
and disable the profile plugin of the same name. Codex loads a cached copy only
while enabled, so without the variable it is inert; it stays behind, and an
edited plugin gets a new key and a new copy. Codex's `-c` splits keys at every
`.`, so a plugin whose name contains one is reported and skipped.

The npins branch pin tracks `sadjow/codex-cli-nix`. Its standalone binary
packaging recipe is called with the distribution's shared nixpkgs, with the
`native` runtime, rather than the packaging repo's own pin.
