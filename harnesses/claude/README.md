# Claude Code

Writes each plugin as a self-contained Claude Code plugin
root, passed with `--plugin-dir` for that session: its manifest, its
discovered skills, and a `.mcp.json`. Each stdio MCP server runs through a
generated launcher that provides `PLUGIN_ROOT`, `PLUGIN_DATA`, placeholder
expansion, and the plugin root as working directory, as the spec requires.
Extra user plugins compose with them; no persistent installation is needed.

The npins branch pin tracks `sadjow/claude-code-nix`. Its standalone binary
packaging recipe is called with the distribution's shared nixpkgs, which allows
unfree packages, rather than the packaging repo's own pin.
