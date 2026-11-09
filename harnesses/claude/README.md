# Claude Code

Writes each plugin as a self-contained Claude Code plugin
root, passed with `--plugin-dir` for that session: its manifest, its
discovered skills, and a `.mcp.json`. Each stdio MCP server runs through a
generated launcher that provides `PLUGIN_ROOT`, `PLUGIN_DATA`, placeholder
expansion and the working directory (doc/index.md, "Working directory").
Extra user plugins compose with them; no persistent installation is needed.

A plugin on `AGENT_DISTRO_PLUGINS` is written the same way into the cache and
added as one more `--plugin-dir`; one named like a plugin of a profile in
effect takes its place. Like the profile's, it lasts only for the session. A
profile read at launch (a `plugin.json`) is written the same way, its
plugins ahead of the variable's.

The commits and pull request descriptions a session writes carry no
attribution of Claude Code's own: the launcher hands it empty `attribution`
text for that session, through `--settings`. A settings file of the user's
that decides attribution — their own, or the launch directory's project or
local one, by `attribution` or the deprecated `includeCoAuthoredBy` — is left
to decide it, and the launch passes nothing. Claude Code keeps only the last
`--settings` it is given, so a `--settings` of the user's own, which comes
after the launcher's, replaces it whole: that launch is the upstream one,
attribution and all, unless those settings say otherwise.

The npins branch pin tracks `sadjow/claude-code-nix`. Its standalone binary
packaging recipe is called with the distribution's shared nixpkgs, which allows
unfree packages, rather than the packaging repo's own pin.
