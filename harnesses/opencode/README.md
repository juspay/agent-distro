# OpenCode

Generates a session config with skills and MCP servers, loaded
through `OPENCODE_CONFIG` after global settings and before project settings.
Custom-provider models come from the launcher's `/v1/models` fetch, with a
cached list or the profile's two aliases as fallback when unavailable.
`AI_GATEWAY=0` omits the generated provider configuration.

OpenCode v1 uses an npins release pin bounded below v2. Its source build is
loaded with the shared pinned flake-compat, honouring upstream’s lock to
preserve binary-cache paths.

The Darwin override supplies `codesign` from nixpkgs' `darwin.sigtool` for
v1.18.34's ad-hoc signing step. Remove it when upstream's Nix recipe supplies
its own signing tool; Linux keeps the upstream derivation unchanged.
