# My coding-agent distribution

Set `my-skills.url` in `flake.nix` to your Agent Plugins repository, then edit
`profile.nix` to name your distribution and optionally configure a gateway.

```sh
nix run           # choose a harness
nix run .#omp
nix run .#codex
nix run .#claude
AI_HARNESS=omp nix run . -- --version
AI_GATEWAY=0 nix run .#omp   # skip gateway initialization, keep plugins
```

Codex and Claude Code use their own login. OMP uses its own provider unless a
gateway is configured. `AI_GATEWAY=0` preserves existing user settings; select
personal models in OMP if you previously used gateway defaults.

Commit `flake.lock` for reproducible builds. Run `nix flake update` to update
the framework and skills together.
