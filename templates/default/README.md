# My coding-agent distribution

Set `my-skills.url` in `flake.nix` to your Agent Plugins repository, then edit
`profile.nix` to name your distribution and optionally configure a gateway.

```sh
nix run           # choose a harness
nix run .#omp
nix run .#codex
nix run .#claude
nix run .#opencode
nix run .#opencode2
nix run .#pi
AI_HARNESS=omp nix run . -- --version
AI_GATEWAY=0 nix run .#omp   # skip gateway initialization, keep plugins
```

Codex and Claude Code use their own login. OMP, both OpenCode versions, and
Pi use their own providers unless a gateway is configured. `AI_GATEWAY=0`
preserves existing user settings; select personal models in OMP if you
previously used gateway defaults.

Commit `flake.lock` for reproducible builds. Run `nix flake update` to update
the framework and skills together.

To install `omp`, `codex`, `claude`, `opencode`, `opencode2`, and `pi` and update them daily, with Home
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
[Install](https://github.com/juspay/agent-distro#install).
