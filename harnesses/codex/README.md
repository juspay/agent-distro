# Codex

Registers each plugin of the profiles in effect as a marketplace of its own
and installs it when its content changes. Steady launches preserve
disabled/removed plugins; new content installs them again. Unrelated settings,
credentials, and sessions persist. With no profile and no
`AGENT_DISTRO_PLUGINS`, nothing is registered. Local sessions default to
`--no-daemon` to avoid experimental background-server startup failures. The
launcher does not install, start, or update a shared server. Explicit
`--remote` connections and daemon-management subcommands remain available.

The directory a plugin is installed from is a copy whose stdio MCP servers run
through generated launchers, in the directory Codex was launched in
(doc/index.md, "Working directory").

A plugin of a profile, and one on `AGENT_DISTRO_PLUGINS`, is never registered
in `config.toml`. Each gets a one-plugin marketplace in the cache, named
`agent-distro-<hash of its cache key>`, and each launch passes `-c` overrides
that register that marketplace and enable the plugin. Codex loads
a plugin only from its install cache, so the first launch runs Codex's own
`plugin add` with a throwaway `CODEX_HOME`: empty, with no `auth.json` or
config (installing from a local marketplace needs no login, checked with
0.160.1), and inside the real one so a rename can move its result into
`$CODEX_HOME/plugins/cache`. The rename is atomic, so an interrupted install
leaves nothing that looks installed and is simply repeated, and of two
concurrent installs the first is kept. The copy stays, inert without the
override; launches stamp the ones they use, and an install removes the ones
unused for 14 days. Codex's `-c` splits its key at every `.` unless the key is
quoted, so a plugin whose name contains one is enabled with its name quoted. A
profile read at launch (an `agent-distro.nix`) reaches Codex the same way: its
plugins get these one-plugin marketplaces.

The npins branch pin tracks `sadjow/codex-cli-nix`. Its standalone binary
packaging recipe is called with the distribution's shared nixpkgs, with the
`native` runtime, rather than the packaging repo's own pin.
