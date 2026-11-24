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

Each launch also hands Claude Code the settings it settles for that session
and the user has not settled themselves, as one `--settings`: the table in
src/harness/claude.ts, a row per setting:

- attribution: empty text, so the commits and pull request descriptions a
  session writes carry none of Claude Code's own. Its keys are `attribution`
  and the deprecated `includeCoAuthoredBy`.
- prompt suggestions: `promptSuggestionEnabled: false`, so no greyed-out
  guess at your next prompt appears in the input box. Each guess is one more
  billed request over the whole conversation. Set
  `"promptSuggestionEnabled": true` in a settings file, or export
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true`, to have them back. The
  **Prompt suggestions** toggle in `/config` lasts one session: turning it on
  removes the key from your settings instead of writing `true`.

A row stands down, on its own, when a settings file of the user's names any of
its keys — their own file, or the launch directory's project or local one.
Every row decided means no flag at all. Claude Code keeps only the last
`--settings` it is given, so a `--settings` of the user's own, which comes
after the launcher's, replaces it whole: that launch is the upstream one,
defaults and all, unless those settings say otherwise.

The npins branch pin tracks `sadjow/claude-code-nix`. Its standalone binary
packaging recipe is called with the distribution's shared nixpkgs, which allows
unfree packages, rather than the packaging repo's own pin.
