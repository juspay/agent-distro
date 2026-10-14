# My coding-agent distribution

This repository is a profile: `agent-distro.nix` names its plugins, packages,
the environment every launch exports and the settings its harnesses default,
and the repository itself is an Agent Plugins directory (`plugin.json`,
`skills/<name>/SKILL.md`, optionally `mcp.json`). Edit `agent-distro.nix` to
name your distribution, add skills under `skills/`, and optionally point OMP
and OpenCode at a model gateway.

## Use it from any agent-distro

agent-distro reads `agent-distro.nix` when a harness starts, so nothing is
built or registered:

```sh
nix run github:juspay/agent-distro -- github:<you>/my-distribution        # choose a harness
nix run github:juspay/agent-distro -- github:<you>/my-distribution omp    # or start one
AI_PROFILE=github:<you>/my-distribution agent-distro claude
```

A terminal opened in this repository starts its agents with this profile.
Check that its `packages` are in the binary cache, for the machine you run it on:
`nix run github:juspay/agent-distro#check-profile`.

## Or build it into a distribution of its own

```sh
nix run           # choose a harness
nix run .#omp    # or any directory name under agent-distro/harnesses/
AI_HARNESS=omp nix run . -- --version
AGENT_DISTRO_SETTINGS=0 nix run .#omp   # load the plugins and nothing else
```

Every harness exports the profile's `env`, and asks for a `secret` variable
that is not set. OMP and OpenCode also read its `settings`, which fill only
what the user's own configuration leaves out. `AGENT_DISTRO_SETTINGS=0`
preserves existing user settings; select personal models in OMP or OpenCode if
you previously used the profile's defaults. Claude Code and Codex use their own
login.

Commit `flake.lock` for reproducible builds. Run `nix flake update` to update
the framework.

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
