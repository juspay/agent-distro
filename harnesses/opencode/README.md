# OpenCode

Generates a session config with skills and MCP servers, loaded
through `OPENCODE_CONFIG` after global settings and before project settings.
Custom-provider models come from the launcher's `/v1/models` fetch, with a
cached list or the profile's two aliases as fallback when unavailable.
`AI_GATEWAY=0` omits the generated provider configuration.

With `AGENT_DISTRO_PLUGINS`, each plugin's skills and server launchers are
translated into the cache, and the launcher writes a session config (the one
above, less the profile plugins those replace, plus theirs) to the cache by
content and points `OPENCODE_CONFIG` at it. OpenCode v2 shares this path.

OpenCode v1 uses an npins release pin bounded below v2. Its source build is
loaded from upstream's lock, except that every nixpkgs in it is the
distribution's shared nixpkgs. Bun alone comes from `bun.nix`, the recipe in
upstream's locked nixpkgs, which `update.py` vendors daily so evaluation never
fetches that nixpkgs: upstream's per-platform `node_modules` hashes hold only
for that bun.

The Darwin override supplies `codesign` from nixpkgs' `darwin.sigtool` and
`codesign_allocate` from `darwin.cctools` for the ad-hoc signing step added in
v1.18.34. Upstream's `stdenvNoCC` supplies neither tool. Remove the override
when upstream's Nix recipe supplies both; Linux keeps the upstream derivation
unchanged.
