{
  description = "The coding-agent distribution: every discovered harness preloaded with Agent Plugins";

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
      cache = import ./lib/cache.nix;
      caIndex = import ./lib/ca-index.nix;
      # The library every consumer reaches as agent-distro.lib, and the two
      # builders both it and this flake use: `mkLaunchers` names this nixpkgs by
      # reference rather than hold its source, and the Home Manager module
      # builds a `profiles` path with `mkProfile`.
      api = import ./lib/api.nix { inherit nixpkgs cache caIndex; };
      mkLaunchers = api.mkLaunchers;
      systems = import ./lib/systems.nix;
      # Unfree so harness recipes (lib/harness-pkgs.nix) share this one instance.
      packageSets = lib.genAttrs systems (system: import nixpkgs { inherit system; config.allowUnfree = true; });
      pkgsFor = system: packageSets.${system};

      # Upstream's own packages, once per system. Each instantiates its
      # packaging repo's nixpkgs, the dominant evaluation cost, so every
      # launcher and output shares these rather than re-importing them.
      harnesses = lib.genAttrs systems (system:
        lib.genAttrs discovered.ordered (name:
          import (./harnesses + "/${name}/source.nix") { pkgs = pkgsFor system; }));

      # The one package per system: every harness launcher, the picker as
      # `bin/agent-distro`, and `share/agent-distro/versions`. A profile is not
      # part of it: profiles are read at launch, or built by mkProfile.
      launchers = lib.genAttrs systems (system: mkLaunchers {
        pkgs = pkgsFor system;
        sources = name: _: harnesses.${system}.${name};
      });
      agentDistro = lib.genAttrs systems (system: launchers.${system}.package);
      # The launcher's own no-compile policy, run ahead of time for a profile repository's CI.
      checkers = lib.genAttrs systems (system:
        let pkgs = pkgsFor system; in
        pkgs.callPackage ./lib/mk-check-profile.nix {
          info = (import ./lib/runtime.nix pkgs).info nixpkgs;
        });
    in
    {
      packages = lib.genAttrs systems (system: lib.removeAttrs launchers.${system} [ "picker" "package" ] // {
        default = agentDistro.${system};
        # The one package under the name the profile-keyed index published it:
        # the transition the installed updates are served from, removed with
        # the extra index keys .github/workflows/cache.yml writes.
        vanilla = agentDistro.${system};
        check-profile = checkers.${system};
      });
      homeManagerModules.default = import ./modules/home-manager.nix {
        packages = agentDistro;
        mkProfile = api.mkProfile;
        defaultFlake = "github:juspay/agent-distro";
        inherit cache caIndex;
      };
      apps = lib.genAttrs systems (system: {
        default = { type = "app"; program = lib.getExe agentDistro.${system}; };
        check-profile = { type = "app"; program = lib.getExe checkers.${system}; };
      });

      # Upstream's own packages, for the daily update to report: a harness
      # version is a property of the lock, not of any profile.
      inherit harnesses;
      harnessMeta = versions: lib.mapAttrs
        (name: meta: {
          inherit (meta) title order;
          releaseNotes = meta.releaseNotes versions.${name};
        })
        discovered.metadata;

      lib = api;
      templates.default = {
        path = ./templates/default;
        description = "A profile: an agent-distro.nix any agent-distro reads";
      };
    };
}
