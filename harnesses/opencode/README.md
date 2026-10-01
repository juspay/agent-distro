# OpenCode

Generates a session config with skills and MCP servers, loaded
through `OPENCODE_CONFIG` after global settings and before project settings.
Custom-provider models come from the launcher's `/v1/models` fetch, with a
cached list or the profile's two aliases as fallback when unavailable.
`AI_GATEWAY=0` omits the generated provider configuration.

OpenCode v1 uses an npins release pin bounded below v2. Its source build is
loaded with the shared pinned flake-compat, honouring upstream’s lock to
preserve binary-cache paths.
