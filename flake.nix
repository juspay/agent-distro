{
  description = "Build a coding-agent distribution: Oh My Pi, Codex, and Claude Code preloaded with a profile of Agent Plugins";

  nixConfig = {
    extra-substituters = "https://cache.nixos.asia/oss";
    extra-trusted-public-keys = "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=";
  };

  inputs = {
    # Oh My Pi from upstream's own flake, pinned to a *release tag* rather than
    # a branch. The tag is the whole point: `update-flake.yml` resolves the
    # latest release daily and rewrites this ref, and the lock makes the pin
    # reproducible in between.
    oh-my-pi.url = "github:can1357/oh-my-pi/v18.2.8";

    # Each packaging repo tracks its current release binary and keeps its own
    # nixpkgs so packaging updates do not depend on OMP's build dependencies.
    codex-cli.url = "github:sadjow/codex-cli-nix";
    claude-code.url = "github:sadjow/claude-code-nix";

    # Upstream's package set, followed rather than shadowed. omp is built from
    # source there, so its derivation hash is the interface to every binary
    # cache — ours included — and overriding `oh-my-pi.inputs.nixpkgs` would
    # re-key that derivation for nothing. Following it here keeps the
    # wrappers and VM tests on the same package set, using the very glibc the omp binary was linked against, instead of a second, newer
    # one that could drift the other way.
    nixpkgs.follows = "oh-my-pi/nixpkgs";
  };

  outputs = { nixpkgs, oh-my-pi, codex-cli, claude-code, ... }:
    let
      upstream = { inherit oh-my-pi codex-cli claude-code; };
      mkLaunchers = import ./lib/mk-launchers.nix upstream;
      mkFlake = import ./lib/mk-flake.nix (upstream // { inherit nixpkgs; });
      vanilla = {
        name = "vanilla";
        description = "Upstream harnesses with your own provider";
        plugins = [ ];
        gateway = null;
      };
    in
    mkFlake { profile = vanilla; } // {
      lib = { inherit mkLaunchers mkFlake; };
      profiles = { inherit vanilla; };
      templates.default = {
        path = ./templates/default;
        description = "A coding-agent distribution with one profile";
      };
    };
}
