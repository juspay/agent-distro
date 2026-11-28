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
in Antigravity's manifest schema, whose name pattern allows no `.`. Such a
name is carried as it is: `agy` lists and loads the plugin, and warns only, in
`agy plugin validate`, that it cannot be published to its marketplace.

`agy` loads these folders as they are placed, links into the cache: with the
owner signed in, `agy plugin list --json` listed each one enabled, `agy plugin
validate` passed through the link, and a session started each linked plugin's
MCP servers.

The launcher places each folder at `~/.gemini/config/plugins/<name>`, today
as a link to its translation; `ENTRIES` in src/harness/agy.ts is the one
place that decides between a link and a copy. An entry is known as
agent-distro's by itself — a link into agent-distro's plugin cache — so no
record has to agree with it, and a launch killed at any point leaves nothing
the next one takes for the user's. An entry that is not agent-distro's is
never changed or removed: a plugin whose name one already holds is skipped,
with a warning. The one exception is a race of two system calls: a user who
deletes agent-distro's link and puts a link of their own under the same name
in the instant a launch is removing it can lose that link (never what it
points at). A removal checks ownership and then unlinks, and there is no
"unlink only if still mine" to close the gap with.

Each launch claims the entries its session uses, in
`~/.local/state/agent-distro/agy-launches/<pid>.json`, outside Google's
directory. That path comes from `HOME` alone, as the plugins directory does,
even when `XDG_STATE_HOME` is set: launches that share a plugins directory
share its claims and lock, and a claim names no directory, so a home reached
through a symlink and by its real path is one home. The claim counts for as
long as that process runs: the launcher, then `agy`, which it `exec`s under
the same pid. A launch writes its claim before it changes the plugins
directory: one that cannot write it places nothing and takes nothing back, and
one that stops partway has claimed what it placed. A launch takes
back an entry of agent-distro's only when no running launch claims it, so a
plugin stays while any `agy` session that wanted it runs, and until the next
launch after that. The launch also holds each translation it uses, in a
`holds/<pid>.json` beside it in the cache, so a session running longer than
the cache's 14 days keeps its translations: the cache's prune skips any
translation a running process holds. Launches never do this at the same time:
each places its entries under an exclusive lock, `lock` beside the claims,
which the operating system releases if a launch dies. A launch that waits 30
seconds for it skips its plugins, with a warning, and still starts. Of two
running launches that want different translations under one name, the later
one keeps the entry already there and uses it. When that entry is another
version of the plugin, it says so, naming the session that holds it: ending
that session and launching again gives this launch's version. When it is the
same plugin translated by another agent-distro build, it says nothing, since
there is nothing to do. A run that only lists models (`agy models`, and so
`agent-distro --models agy`) changes nothing in `~/.gemini/config/`. Every
other run, short ones such as `agy --version` or `agy plugin list` included,
places and takes back as a session does: `agy plugin list` then shows what a
session would load, and a short run never takes back what a running session
claims. Without `HOME`, or with a home that cannot be written, the plugins are
skipped with a warning naming what failed, and `agy` still starts. A second
user sharing the home cannot read the first's claims (they are written
`0600`), so their launches place nothing, take nothing back, and say so.

`~/.gemini/config/` is shared: Google documents the same plugins directory
for the Antigravity desktop app and IDE. A plugin placed for an `agy` session
would show up in them too, until a later launch takes it back.

A model is given as `--model <slug>`. `agent-distro --models agy` runs
`agy models`, which, its output not being a terminal, prints one model a line:
its slug, a tab, and its name, with "Fetching available models..." on stderr.
The reader takes each slug and refuses any other line rather than guess,
spaces between slug and name included: Google's documentation shows them, but
`agy` was not seen to print them. Signed out, `agy models` exits 1 with
"Please sign in to view available models", and `agent-distro --models agy`
fails with those words.

The picker does not read the system keyring, where Google documents that
`agy` keeps its sign-in. It marks the row signed in only for the two
alternatives Google documents: `GEMINI_API_KEY` with
`"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json`, or
`AGY_ADC_AUTH=true`. Otherwise the row shows neither a mark nor
"Not signed in".

Like Claude Code and Codex, `agy` has a login of its own, so the launcher never
prompts for the profile's `secret` variables. It exports the profile's other
`env` entries and puts its packages on `PATH`, as every launcher does.

Seen with the owner signed in, on 1.5.19: symlinked folders load, a dotted
name loads, the shape of `agy models` signed in and out, `agy plugin list
--json` and `agy plugin validate` working signed out, and a different `HOME`
moving `~/.gemini` with it. Unproven still:

- when a running `agy` reads a plugin folder: only at start, or again later;
- what `agy` does with a manifest field outside Antigravity's rules;
- that the desktop app and IDE show what is placed there.

The VM checks prove what needs no account: the launcher starts, `agy
--version` answers, the folders are where Google documents that `agy` reads
them, their MCP servers start through the commands `agy` would run, an entry
a running launch claims stays, and a later launch takes back the rest.
