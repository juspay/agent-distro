{
  description = "Build a coding-agent distribution: Oh My Pi, Codex, Claude Code, OpenCode v1, OpenCode v2, and Pi preloaded with a profile of Agent Plugins";

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
    oh-my-pi.url = "github:can1357/oh-my-pi/v18.4.4";

    # Upstream release tag, advanced daily without overriding its nixpkgs.
    opencode.url = "github:anomalyco/opencode/v1.18.33";

    # Each packaging repo tracks its current release binary and keeps its own
    # nixpkgs so packaging updates do not depend on OMP's build dependencies.
    codex-cli.url = "github:sadjow/codex-cli-nix";
    claude-code.url = "github:sadjow/claude-code-nix";
    pi.url = "github:sadjow/pi-nix";

    # Upstream's package set, followed rather than shadowed. omp is built from
    # source there, so its derivation hash is the interface to every binary
    # cache — ours included — and overriding `oh-my-pi.inputs.nixpkgs` would
    # re-key that derivation for nothing. Following it here keeps the
    # wrappers and VM tests on the same package set, using the very glibc the omp binary was linked against, instead of a second, newer
    # one that could drift the other way.
    nixpkgs.follows = "oh-my-pi/nixpkgs";
  };

  outputs = { nixpkgs, oh-my-pi, codex-cli, claude-code, opencode, pi, ... }:
    let
      inherit (nixpkgs) lib;
      opencode-v2 = pkgs: pkgs.callPackage ./pkgs/opencode-v2 { };
      upstream = { inherit oh-my-pi codex-cli claude-code opencode opencode-v2 pi; };
      mkLaunchers = import ./lib/mk-launchers.nix upstream;
      mkFlake = import ./lib/mk-flake.nix (upstream // { inherit nixpkgs; });
      systems = import ./lib/systems.nix;

      # Discovered, not listed: adding a directory is the whole registration
      # step, which is what keeps one distribution's plugins, gateway and name
      # out of this file.
      profiles = lib.mapAttrs
        (name: _:
          let profile = import (./profiles + "/${name}/profile.nix"); in
          # AI_PROFILE, the Codex marketplace and the picker all key off the
          # directory name, so a mismatch would surface far from its cause.
          if profile.name == name then import ./lib/validate-profile.nix profile
          else throw "profiles/${name}/profile.nix declares name \"${profile.name}\"; it must match its directory.")
        (lib.filterAttrs (_: type: type == "directory") (builtins.readDir ./profiles));

      registry = import ./profiles/registry.nix;
      default =
        if profiles ? ${registry.default} then registry.default
        else throw "profiles/registry.nix defaults to \"${registry.default}\", which is not a directory under profiles/.";

      bundles = lib.genAttrs systems (system:
        let pkgs = import nixpkgs { inherit system; };
        in lib.mapAttrs (_: profile: (mkLaunchers { inherit pkgs profile; }).bundle) profiles);

      pickers = lib.genAttrs systems (system:
        let pkgs = import nixpkgs { inherit system; };
        in pkgs.callPackage ./adapters/picker.nix {
          inherit default;
          profiles = lib.mapAttrs
            (_: profile: { inherit profile; launchers = mkLaunchers { inherit pkgs profile; }; })
            profiles;
        });
    in
    {
      # The picker stays the runnable default; profile bundles install all six commands.
      packages = lib.genAttrs systems (system: bundles.${system} // { default = pickers.${system}; });
      homeManagerModules.default = import ./modules/home-manager.nix {
        inherit bundles;
        defaultProfile = default;
        defaultFlake = "github:juspay/agent-distro";
      };
      apps = lib.mapAttrs
        (_: picker: { default = { type = "app"; program = lib.getExe picker; }; })
        pickers;

      # Upstream's own packages, for the daily update to report: a harness
      # version is a property of the lock, not of any profile.
      harnesses = lib.genAttrs systems (system: {
        pi = pi.packages.${system}.default;
        omp = oh-my-pi.packages.${system}.default;
        codex = codex-cli.packages.${system}.default;
        claude = claude-code.packages.${system}.default;
        opencode = opencode.packages.${system}.default;
        opencode2 = opencode-v2 nixpkgs.legacyPackages.${system};
      });

      lib = { inherit mkLaunchers mkFlake; };
      # Resolved profile data, for the tests and for third parties.
      inherit profiles;
      templates.default = {
        path = ./templates/default;
        description = "A coding-agent distribution with one profile";
      };
    };
}
