# Bind upstream inputs once; consumers add their own outputs with //.
{ nixpkgs, oh-my-pi, codex-cli, claude-code }:
let
  mkLaunchers = import ./mk-launchers.nix { inherit oh-my-pi codex-cli claude-code; };
in
{ profile, systems ? import ./systems.nix }:
let
  checked = import ./validate-profile.nix profile;
  packages = nixpkgs.lib.genAttrs systems (system:
    let
      launchers = mkLaunchers { pkgs = import nixpkgs { inherit system; }; inherit profile; };
    in
    { inherit (launchers) omp codex claude; default = launchers.picker; ${checked.name} = launchers.bundle; });
in
builtins.seq checked {
  inherit packages;
  homeManagerModules.default = import ../modules/home-manager.nix {
    bundles = nixpkgs.lib.mapAttrs (_: ps: { ${checked.name} = ps.${checked.name}; }) packages;
    defaultProfile = checked.name;
  };
  apps = nixpkgs.lib.mapAttrs
    (_: ps: nixpkgs.lib.mapAttrs
      (_: package: {
        type = "app";
        program = nixpkgs.lib.getExe package;
      })
      (builtins.removeAttrs ps [ checked.name ]))
    packages;
}
