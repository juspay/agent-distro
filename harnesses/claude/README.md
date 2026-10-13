# Claude Code

Writes each plugin as a self-contained Claude Code plugin
root, passed with `--plugin-dir` for that session: its manifest, its
discovered skills, and a `.mcp.json`. Each stdio MCP server runs through a
generated launcher that provides `PLUGIN_ROOT`, `PLUGIN_DATA`, placeholder
expansion, and the directory the harness was launched in as working directory.
The spec's default is the plugin root (§7.2.1), which for a plugin from a flake
reference is under `/nix/store`, where `nix run github:…` cannot run at all; a
plugin's own `cwd` still wins.
Extra user plugins compose with them; no persistent installation is needed.

A plugin on `AGENT_DISTRO_PLUGINS` is written the same way into the cache and
added as one more `--plugin-dir`; one named like a profile plugin takes its
place. Like the profile's, it lasts only for the session. A profile read at
launch (an `agent-distro.nix`) is written the same way, its plugins in place of
every built-in one.

The npins branch pin tracks `sadjow/claude-code-nix`. Its standalone binary
packaging recipe is called with the distribution's shared nixpkgs, which allows
unfree packages, rather than the packaging repo's own pin.
