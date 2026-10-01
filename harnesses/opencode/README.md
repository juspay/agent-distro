# OpenCode

Generates a session config with skills and MCP servers, loaded
through `OPENCODE_CONFIG` after global settings and before project settings.
Custom-provider models come from the launcher's `/v1/models` fetch, with a
cached list or the profile's two aliases as fallback when unavailable.
`AI_GATEWAY=0` omits the generated provider configuration.
