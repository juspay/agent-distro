# Bind upstream inputs once; consumers add their own outputs with //.
{ nixpkgs, oh-my-pi, codex-cli, claude-code, opencode }:
let
  mkLaunchers = import ./mk-launchers.nix { inherit oh-my-pi codex-cli claude-code opencode; };
in
{ profile, systems ? import ./systems.nix }:
let
  checked = import ./validate-profile.nix profile;
  launchers = nixpkgs.lib.genAttrs systems (system:
    mkLaunchers { pkgs = import nixpkgs { inherit system; }; inherit profile; });
  # Runnable outputs are shared by packages and apps; bundles have no main program.
  runnable = nixpkgs.lib.mapAttrs
    (_: ls: { inherit (ls) omp codex claude opencode; default = ls.picker; })
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
  };
  apps = nixpkgs.lib.mapAttrs
    (_: nixpkgs.lib.mapAttrs
      (_: package: {
        type = "app";
        program = nixpkgs.lib.getExe package;
      }))
    runnable;
}
