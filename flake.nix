{
  description = "Build a coding-agent distribution: Oh My Pi, Codex, and Claude Code preloaded with a profile of Agent Plugins";

  nixConfig = {
    extra-substituters = "https://cache.nixos.asia/oss";
    extra-trusted-public-keys = "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=";
  };

  # Framework inputs only. A profile's plugin sources are pinned inside
  # `profiles/<name>/npins/`, never here: this lock is what every consumer of
  # `lib.mkFlake` inherits, so one distribution's plugins must not appear in it.
  inputs = {
    # Oh My Pi from upstream's own flake, pinned to a *release tag* rather than
    # a branch. The tag is the whole point: `update-flake.yml` resolves the
    # latest release daily and rewrites this ref, and the lock makes the pin
    # reproducible in between.
    oh-my-pi.url = "github:can1357/oh-my-pi/v18.3.0";

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
      inherit (nixpkgs) lib;
      upstream = { inherit oh-my-pi codex-cli claude-code; };
      mkLaunchers = import ./lib/mk-launchers.nix upstream;
      mkFlake = import ./lib/mk-flake.nix (upstream // { inherit nixpkgs; });
      systems = import ./lib/systems.nix;

      # Profiles are discovered, not listed: adding `profiles/<name>/profile.nix`
      # is the whole registration step. That is what lets this file stay free of
      # any one distribution's plugins, gateway, or name.
      profiles = lib.mapAttrs
        (name: _:
          let
            declared = import (./profiles + "/${name}/profile.nix");
            profile = if lib.isFunction declared then declared { } else declared;
          in
          # The directory name is the profile's identity — AI_PROFILE, the Codex
          # marketplace, and the menu all key off it — so a mismatch would
          # surface far from the line that caused it.
          if profile.name == name then profile
          else throw "profiles/${name}/profile.nix declares name \"${profile.name}\"; it must match its directory.")
        (lib.filterAttrs (_: type: type == "directory") (builtins.readDir ./profiles));

      registry = import ./profiles/registry.nix;
      default =
        if profiles ? ${registry.default} then registry.default
        else throw "profiles/registry.nix defaults to \"${registry.default}\", which is not a directory under profiles/.";

      menus = lib.genAttrs systems (system:
        let pkgs = import nixpkgs { inherit system; };
        in pkgs.callPackage ./adapters/menu.nix {
          inherit profiles default;
          launchers = lib.mapAttrs (_: profile: mkLaunchers { inherit pkgs profile; }) profiles;
        });
    in
    {
      # The profile menu is the only package. Every harness is reached through
      # it, or past it with AI_PROFILE and AI_HARNESS, so there is no per-profile
      # output set to keep in step with `profiles/`.
      packages = lib.genAttrs systems (system: { default = menus.${system}; });
      apps = lib.mapAttrs
        (system: menu: { default = { type = "app"; program = lib.getExe menu; }; })
        menus;

      lib = { inherit mkLaunchers mkFlake; };
      # Resolved profile data — plugins already fetched and bound — for the
      # tests, for third parties, and for `lib.mkLaunchers`.
      inherit profiles;
      templates.default = {
        path = ./templates/default;
        description = "A coding-agent distribution with one profile";
      };
    };
}
