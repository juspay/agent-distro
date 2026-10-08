# My coding-agent distribution

Set `my-skills.url` in `flake.nix` to your Agent Plugins repository, then edit
`profile.nix` to name your distribution and optionally configure a gateway.

```sh
nix run           # choose a harness
nix run .#omp    # or any directory name under agent-distro/harnesses/
AI_HARNESS=omp nix run . -- --version
AI_GATEWAY=0 nix run .#omp   # skip gateway initialization, keep plugins
```

Codex and Claude Code use their own login. OMP, Pi, and both OpenCode versions use their own providers unless a
gateway is configured. `AI_GATEWAY=0` preserves existing user settings; select
personal models in OMP or Pi if you previously used gateway defaults.

Commit `flake.lock` for reproducible builds. Run `nix flake update` to update
the framework and skills together.

To install every harness and update them daily, with Home
Manager:

```nix
{
  imports = [ inputs.my-distribution.homeManagerModules.default ];
  services.agent-distro = {
    enable = true;
    flake = "github:<you>/my-distribution";
  };
}
```

Binary cache and manual install: see agent-distro's
[Install](https://agent-distro.nixos.asia/#install).

To add a harness to the framework, create `harnesses/<name>/` with `meta.nix`,
`default.nix`, `source.nix`, and `README.md`; see [Adding a harness](https://agent-distro.nixos.asia/#adding-a-harness).
