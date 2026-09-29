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

To install all three commands and refresh them daily, import your distribution's
Home Manager module. Set `flake` to your own published URL; the profile defaults
to the name in `profile.nix`:

```nix
{
  imports = [ inputs.my-distribution.homeManagerModules.default ];
  services.agent-distro = {
    enable = true;
    flake = "github:<you>/my-distribution";
  };
}
```

See agent-distro's “Install and stay current” section for binary cache settings
and PATH collision warnings. Without Home Manager, use
`nix profile install github:<you>/my-distribution#<profile-name>` and
`nix profile upgrade <profile-name>`.
