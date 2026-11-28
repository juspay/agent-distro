# Antigravity CLI

Google's prebuilt `agy` binary, pinned per system in `sources.json` from the
manifests Google's installer reads, and checked against the SHA-512 each
manifest gives. `update.py` moves the pin only when all three manifests agree
on a newer version. The binary updates itself in the background unless
`AGY_CLI_DISABLE_AUTO_UPDATE=true`, which the package sets: a store path cannot
be replaced, and the daily update moves the pin instead. It is unfree; harness
recipes are called with a package set that allows that.

`agy` has no flag that loads a plugin for one launch. It reads plugin folders
from `~/.gemini/config/plugins/`, so each plugin of the profile in effect and
of `AGENT_DISTRO_PLUGINS` is translated into an Antigravity plugin folder in
the cache: its manifest under Antigravity's own `$schema`, its discovered
skills, and an `mcp_config.json`. Each stdio MCP server runs through a
generated launcher that provides `PLUGIN_ROOT`, `PLUGIN_DATA`, placeholder
expansion and the working directory (doc/index.md, "Working directory"). A
Streamable HTTP server is written with its `serverUrl` and headers. An SSE
server is skipped with a warning, since Antigravity does not support SSE.

The launch links each folder into `~/.gemini/config/plugins/<name>` and
records what it linked in `~/.gemini/config/.agent-distro-launch.json`. The
next launch removes every link that is still as recorded, then makes its own.
So a plugin stays until the next `agy` launch, however much later that is,
and launches that run at the same moment with different plugins can see each
other's. A folder or link the launcher did not make is never changed or
removed: a plugin whose name one already holds is skipped, with a warning. A
record that is not agent-distro's stops the launch before anything changes.
Without `HOME`, or with a `~/.gemini/config` that cannot be written, the
links are skipped with a warning and `agy` still starts.

`~/.gemini/config/` is shared: the Antigravity desktop app and IDE read the
same plugins directory. A plugin the last `agy` launch linked shows up in
them too, until the next `agy` launch takes it back.

A model is given as `--model <slug>`. `agent-distro --models agy` runs
`agy models`, which Google documents as one model a line, its slug and then
its name. The reader takes each slug and refuses any other line rather than
guess.

The picker does not read the system keyring, where `agy` keeps its Google
sign-in. It marks the row signed in only for the two alternatives Google
documents: `GEMINI_API_KEY` with `"modelProvider": "gemini"` in
`~/.gemini/antigravity-cli/settings.json`, or `AGY_ADC_AUTH=true`. Otherwise
the row shows neither a mark nor "Not signed in".

Unproven, since no check here can sign in: what `agy models` prints signed in
(the reader follows Google's documented sample), whether `agy` loads a plugin
folder that is a symlink, and whether a moved `HOME` moves `~/.gemini`. The VM
checks prove what needs no account: the launcher starts, `agy --version`
answers, the folders are where `agy` reads them, their MCP servers start
through the commands `agy` would run, and the next launch takes them back.
