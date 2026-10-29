# My coding-agent distribution

This repository is a profile, and it is an [Agent
Plugin](https://agent-plugins.org/specification/): `plugin.json` names it — its
`name` and `description` are the profile's — and `skills/<name>/SKILL.md` holds
the skills, with MCP servers in `mcp.json`. The directory is the profile's first
plugin. There is no flake here and nothing to build or register: agent-distro
reads it when a harness starts.

`plugin.json` may also carry `extensions."asia.nixos.agent-distro"`, the shape
this template shows empty: `plugins` for more plugin directories (paths
beginning with `./`) or flake references, `packages` for nixpkgs attribute paths
put on `PATH`, and `env` and `settings`. See
[Profiles](https://agent-distro.kolu.dev/#profiles).

Edit `plugin.json` to name your distribution, add skills under `skills/`, and
optionally point OMP and OpenCode at a model gateway.

## Use it from any agent-distro

```sh
nix run github:juspay/agent-distro -- github:<you>/my-distribution        # choose a harness
nix run github:juspay/agent-distro -- github:<you>/my-distribution omp    # or start one
AI_PROFILE=github:<you>/my-distribution agent-distro claude               # a reference, or
AI_PROFILE=~/src/my-distribution agent-distro omp                         # a path to a clone
AGENT_DISTRO_SETTINGS=0 agent-distro omp                                  # load the plugins and nothing else
```

A terminal opened in this repository starts its agents with this profile,
composed over whatever `AI_PROFILE` already names.

Every harness exports the profile's `env`, and asks for a `secret` variable
that is not set. OMP and OpenCode also read its `settings`, which fill only
what the user's own configuration leaves out. `AGENT_DISTRO_SETTINGS=0`
preserves existing user settings; select personal models in OMP or OpenCode if
you previously used the profile's defaults. Claude Code and Codex use their own
login.

Nothing here is pinned, so what you push is what the next launch reads. Check
that the `packages` it names are in a binary cache, for every machine that runs
it: `nix run github:juspay/agent-distro#check-profile`, once per platform in
CI.

## Or pin it into the store

`agent-distro.lib.mkProfile` builds this repository into a store path — its
plugins read and its `packages` resolved at build time — and that path is a
profile reference like any other, offline at launch. In your own configuration
flake, with this repository as an input
(`inputs.my-distribution = { url = "github:<you>/my-distribution"; flake = false; };`):

```nix
agent-distro.lib.mkProfile { inherit system; profile = inputs.my-distribution; }
```

To install every harness and update them daily, with Home Manager — the module
is agent-distro's own, and this profile is one entry of its `profiles`:

```nix
{
  imports = [ inputs.agent-distro.homeManagerModules.default ];
  services.agent-distro = {
    enable = true;
    profiles = [ inputs.my-distribution ];
  };
}
```

Binary cache and manual install: see agent-distro's
[Install](https://agent-distro.kolu.dev/#install).

To add a harness to the framework, create `harnesses/<name>/` with `meta.nix`,
`default.nix`, `source.nix`, and `README.md`; see [Adding a harness](https://agent-distro.kolu.dev/#adding-a-harness).
