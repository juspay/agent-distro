{ nixpkgs }:
let
  mkLaunchers = import ./mk-launchers.nix;
  # A third-party distribution: same library shape as flake.nix exposes, and
  # the `cache` it passed is handed straight back under lib.cache. `mkFlake`
  # points back at this builder so the returned distribution can build further
  # flake outputs the same way.
  build = { profile, systems ? import ./systems.nix, cache ? import ./cache.nix }:
    let
      checked = import ./validate-profile.nix profile;
      launchers = nixpkgs.lib.genAttrs systems (system:
        mkLaunchers { pkgs = import nixpkgs { inherit system; config.allowUnfree = true; }; inherit profile; });
      # Runnable outputs are shared by packages and apps; bundles have no main program.
      runnable = nixpkgs.lib.mapAttrs
        (_: ls: nixpkgs.lib.genAttrs ls.bundle.commands (name: ls.${name}) // { default = ls.picker; })
        launchers;
      packages = nixpkgs.lib.mapAttrs
        (system: ps: ps // { ${checked.name} = launchers.${system}.bundle; })
        runnable;
    in
    builtins.seq checked {
      inherit packages;
      homeManagerModules.default = import ../modules/home-manager.nix {
        bundles = nixpkgs.lib.mapAttrs (_: ps: { ${checked.name} = ps.${checked.name}; }) packages;
        defaultProfile = checked.name;
        inherit cache;
      };
      apps = nixpkgs.lib.mapAttrs
        (_: nixpkgs.lib.mapAttrs
          (_: package: {
            type = "app";
            program = nixpkgs.lib.getExe package;
          }))
        runnable;
      lib = import ./api.nix { inherit nixpkgs mkLaunchers cache; mkFlake = build; };
    };
in
build
