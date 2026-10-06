{
  description = "Build a coding-agent distribution with every discovered harness preloaded with Agent Plugins";

  nixConfig = {
    extra-substituters = "https://cache.nixos.asia/oss";
    extra-trusted-public-keys = "oss:KO872wNJkCDgmGN3xy9dT89WAhvv13EiKncTtHDItVU=";
  };

  # Start at OMP's nixpkgs revision. Daily nix flake update advances this
  # independently of OMP's upstream lock from now on.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      inherit (nixpkgs) lib;
      discovered = import ./lib/discover-harnesses.nix;
      mkLaunchers = import ./lib/mk-launchers.nix;
      mkFlake = import ./lib/mk-flake.nix { inherit nixpkgs; };
      systems = import ./lib/systems.nix;
      # Unfree so harness recipes (lib/harness-pkgs.nix) share this one instance.
      packageSets = lib.genAttrs systems (system: import nixpkgs { inherit system; config.allowUnfree = true; });
      pkgsFor = system: packageSets.${system};

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

      # Upstream's own packages, once per system. Each instantiates its
      # packaging repo's nixpkgs, the dominant evaluation cost, so every
      # profile and output shares these rather than re-importing them.
      harnesses = lib.genAttrs systems (system:
        lib.genAttrs discovered.ordered (name:
          import (./harnesses + "/${name}/source.nix") { pkgs = pkgsFor system; }));

      launchers = lib.genAttrs systems (system:
        lib.mapAttrs
          (_: profile: mkLaunchers {
            inherit profile;
            pkgs = pkgsFor system;
            sources = name: _: harnesses.${system}.${name};
          })
          profiles);

      bundles = lib.mapAttrs (_: lib.mapAttrs (_: ls: ls.bundle)) launchers;

      pickers = lib.genAttrs systems (system:
        (pkgsFor system).callPackage ./lib/picker.nix {
          inherit default;
          profiles = lib.mapAttrs
            (name: profile: { inherit profile; launchers = launchers.${system}.${name}; })
            profiles;
        });
    in
    {
      # The picker stays the runnable default; profile bundles install every harness command.
      packages = lib.genAttrs systems (system: bundles.${system} // { default = pickers.${system}; });
      homeManagerModules.default = import ./modules/home-manager.nix {
        inherit bundles;
        defaultProfile = default;
        defaultFlake = "github:juspay/agent-distro";
        cache = import ./lib/cache.nix;
      };
      apps = lib.mapAttrs
        (_: picker: { default = { type = "app"; program = lib.getExe picker; }; })
        pickers;

      # Upstream's own packages, for the daily update to report: a harness
      # version is a property of the lock, not of any profile.
      inherit harnesses;
      harnessMeta = versions: lib.mapAttrs
        (name: meta: {
          inherit (meta) title order;
          releaseNotes = meta.releaseNotes versions.${name};
        })
        discovered.metadata;

      lib = {
        inherit mkLaunchers mkFlake;
        cache = import ./lib/cache.nix;
        stateDirectory = import ./lib/state-directory.nix;
        mkShims = import ./lib/mk-shims.nix;
        mkUpdater = import ./lib/mk-updater.nix;
        mkPicker = import ./lib/mk-picker.nix;
        schedule = import ./lib/schedule.nix lib;
      };
      # Resolved profile data, for the tests and for third parties.
      inherit profiles;
      templates.default = {
        path = ./templates/default;
        description = "A coding-agent distribution with one profile";
      };
    };
}
