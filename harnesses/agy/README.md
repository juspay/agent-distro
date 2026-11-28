# Antigravity CLI

Google's prebuilt `agy` binary, pinned per system in `sources.json` from the
manifests Google's installer reads, and checked against the SHA-512 each
manifest gives. `update.py` moves the pin only when all three manifests agree
on a newer version. Google documents that the binary updates itself in the
background unless `AGY_CLI_DISABLE_AUTO_UPDATE=true`, which the package sets:
a store path cannot be replaced, and the daily update moves the pin instead.
It is unfree; harness recipes are called with a package set that allows that.

Google documents no flag that loads a plugin for one launch. It documents
`~/.gemini/config/plugins/` as where `agy` reads plugin folders, so each plugin
of the profile in effect and of `AGENT_DISTRO_PLUGINS` is translated into an
Antigravity plugin folder in the cache: its manifest under Antigravity's own
`$schema`, its discovered skills, and an `mcp_config.json`. Each stdio MCP
server runs through a generated launcher that provides `PLUGIN_ROOT`,
`PLUGIN_DATA`, placeholder expansion and the working directory (doc/index.md,
"Working directory"). A Streamable HTTP server is written with its
`serverUrl` and headers. An SSE server is skipped with a warning: Google
documents that Antigravity does not support SSE. The manifest's fields are all
in Antigravity's manifest schema, but that schema allows fewer plugin names
(no `.`); such a name is carried as it is, with a warning.

The launcher places each folder at `~/.gemini/config/plugins/<name>`, today
as a link to its translation; `ENTRIES` in src/harness/agy.ts is the one
place that decides between a link and a copy. An entry is known as
agent-distro's by itself — a link into agent-distro's plugin cache — so no
record has to agree with it, and a launch killed at any point leaves nothing
the next one takes for the user's. An entry that is not agent-distro's is
never changed or removed: a plugin whose name one already holds is skipped,
with a warning.

Each launch claims the entries its session uses, in
`~/.local/state/agent-distro/agy-launches/<pid>.json`, outside Google's
directory. That path comes from `HOME` alone, as the plugins directory does,
even when `XDG_STATE_HOME` is set: launches that share a plugins directory
share its claims and lock. The claim counts for as long as that process runs:
the launcher, then `agy`, which it `exec`s under the same pid. A launch takes
back an entry of agent-distro's only when no running launch claims it, so a
plugin stays while any `agy` session that wanted it runs, and until the next
launch after that. Launches never do this at the same time: each places its
entries under an exclusive lock, `lock` beside the claims, which the operating
system releases if a launch dies. A launch that waits 30 seconds for it skips
its plugins, with a warning, and still starts. Of two running launches that
want different translations under one name, the later one keeps the entry
already there, uses it, and says so. A run that only lists models
(`agy models`, and so `agent-distro --models agy`) changes nothing in
`~/.gemini/config/`. Without `HOME`, or with a home that cannot be written,
the plugins are skipped with a warning and `agy` still starts.

`~/.gemini/config/` is shared: Google documents the same plugins directory
for the Antigravity desktop app and IDE. A plugin placed for an `agy` session
would show up in them too, until a later launch takes it back.

A model is given as `--model <slug>`. `agent-distro --models agy` runs
`agy models`, which Google documents as one model a line, its slug and then
its name. The reader takes each slug and refuses any other line rather than
guess.

The picker does not read the system keyring, where Google documents that
`agy` keeps its sign-in. It marks the row signed in only for the two
alternatives Google documents: `GEMINI_API_KEY` with
`"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json`, or
`AGY_ADC_AUTH=true`. Otherwise the row shows neither a mark nor
"Not signed in".

Like Claude Code and Codex, `agy` has a login of its own, so the launcher never
prompts for the profile's `secret` variables. It exports the profile's other
`env` entries and puts its packages on `PATH`, as every launcher does.

Unproven, since nobody has run `agy` with plugins or signed in:

- that `agy` loads a plugin folder placed by hand, and one that is a link into
  the cache (Google's changelog mentions plugins "installed as symbolic links",
  and skips symlinked entries of a workspace's plugin lists);
- what `agy` does with a plugin name or manifest field outside Antigravity's
  rules;
- when a running `agy` reads a plugin folder: only at start, or again later;
- what `agy models` prints and how it exits, signed in and signed out (the
  reader follows Google's documented sample);
- whether `agy plugin list --json` and `agy plugin validate` work signed out;
- whether a different `HOME` alone moves `~/.gemini`;
- that the desktop app and IDE show what is placed there.

The VM checks prove what needs no account: the launcher starts, `agy
--version` answers, the folders are where Google documents that `agy` reads
them, their MCP servers start through the commands `agy` would run, an entry
a running launch claims stays, and a later launch takes back the rest.
