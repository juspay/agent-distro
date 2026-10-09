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
key>`, and each launch passes `-c` overrides that register that marketplace,
enable the plugin and disable the profile plugin of the same name. Codex loads
a plugin only from its install cache, so the first launch runs Codex's own
`plugin add` with a throwaway `CODEX_HOME`: empty, with no `auth.json` or
config (installing from a local marketplace needs no login, checked with
0.160.1), and inside the real one so a rename can move its result into
`$CODEX_HOME/plugins/cache`. The rename is atomic, so an interrupted install
leaves nothing that looks installed and is simply repeated, and of two
concurrent installs the first is kept. The copy stays, inert without the
override; launches stamp the ones they use, and an install removes the ones
unused for 14 days. Codex's `-c` splits keys at every `.`, so a plugin whose
name contains one is reported and skipped. A profile read at launch (an
`agent-distro.nix`) reaches Codex the same way: its plugins get these
one-plugin marketplaces, and every plugin of the built-in profile is disabled
for that launch.

The npins branch pin tracks `sadjow/codex-cli-nix`. Its standalone binary
packaging recipe is called with the distribution's shared nixpkgs, with the
`native` runtime, rather than the packaging repo's own pin.
