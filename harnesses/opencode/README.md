# OpenCode

Uses its own adapter, emits `skills`, `mcp.servers` and `providers`
configuration, and adds `--standalone` only to interactive TUI launches so a
shared background server cannot supply another session's config. There is no
`small_model`: the gateway's small model is set as the title agent's model
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

## Gateway

A gateway in effect adds two things to the session config:

- `providers.litellm`, an OpenAI-compatible provider pointing at the gateway's
  `/v1` — no `models` map, and no key: the launcher exports `LITELLM_API_KEY`
  (the profile's `keyEnv`, under that name) and nothing is written to disk.
- `plugins`, naming the vendored [`opencode-plugin-litellm`](https://github.com/yuseferi/opencode-litellm)
  (`harnesses/opencode/npins`, unpacked into the store). It registers the
  provider's models from the gateway's `/v1/models` and `/v1/model/info` —
  names, context and output limits, prices, tool/vision/reasoning capabilities —
  into a cache of its own, and refreshes them in the background on new sessions.
  OpenCode concatenates `plugins` across config files, so a user's own plugins
  survive.

The store path handed to OpenCode is the pin's `src` directory: a local plugin
is a directory OpenCode looks in for `index`/`server`, so the package's own
`exports` entry does not apply. That is the whole reason the config names
`<store>/src` rather than the store path npins unpacks the package into.

A launch whose discovery cannot reach the gateway shows no gateway models
rather than a stale list: the plugin caches what a successful discovery
returned, and a later launch — or its background refresh — picks that up once
the gateway answers again.

`AI_GATEWAY=0` omits the provider and the plugin.
