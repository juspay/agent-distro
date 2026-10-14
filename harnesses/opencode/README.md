# OpenCode

Uses its own adapter, emits `skills`, `mcp.servers` and `providers`
configuration, and adds `--standalone` only to interactive TUI launches so a
shared background server cannot supply another session's config. There is no
`small_model`: a profile points the faster model at the title agent
(`agents.title.model`). For scripted runs use `opencode run --standalone`; for
inspection use `opencode api --standalone` because `debug config` and
`mcp list` attach to the shared service.

`AGENT_DISTRO_PLUGINS` reaches it through OpenCode's adapter, and each stdio MCP
server runs through a generated launcher in the launch directory (doc/index.md,
"Working directory").

OpenCode uses upstream's prebuilt npm binaries because its Nix build is not
reliable yet. `update.py` advances `sources.json` from upstream's installer
metadata (or npm's `latest` dist-tag) only after all three platform downloads
succeed.

## The LiteLLM plugin, and a profile's settings

The session config opens with the vendored
[`opencode-plugin-litellm`](https://github.com/yuseferi/opencode-litellm)
(`harnesses/opencode/npins`, unpacked into the store; re-pinned daily within
its major), for every launch, profile or not. It registers a LiteLLM server's
models when a configuration names one — `providers.litellm` in any layer this
document merges with, or `LITELLM_BASE_URL` in the environment — reading names,
context and output limits, prices and tool/vision/reasoning capabilities from
the server's `/v1/models` and `/v1/model/info` into a cache of its own, and
refreshing them in the background on new sessions. With nothing naming one it
only probes `localhost:4000`, `8000` and `8080` once at startup. OpenCode
concatenates `plugins` across config files, so a user's own plugins survive.

The store path handed to OpenCode is the pin's `src` directory: a local plugin
is a directory OpenCode looks in for `index`/`server`, so the package's own
`exports` entry does not apply. That is the whole reason the config names
`<store>/src` rather than the store path npins unpacks the package into.

A launch that cannot reach the server shows no models rather than a stale list:
the plugin fills its cache when discovery succeeds, and refreshes it in the
background while OpenCode runs.

A profile's `settings.opencode` is merged over the session config at launch, by
`src/harness/opencode-settings.ts`, and written into the cache by its contents:
objects merge key-wise, so a profile's `providers` joins the document rather
than replacing it, and `plugins` arrays concatenate, the vendored one first.
`skills` and `mcp.servers` are the launcher's own — they name what this launch's
plugins resolved to — so a profile's are ignored. No key is ever written: the
plugin reads `LITELLM_API_KEY` from the environment, which the profile's `env`
exports (prompting for it first when it is not set).

`AGENT_DISTRO_SETTINGS=0` loads the plugins and nothing else: no `env`, no
`settings`, so nothing the profile says names a server for the plugin.
